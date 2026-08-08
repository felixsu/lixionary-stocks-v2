"""Yahoo Finance price source.

Yahoo is the only free source that still works for IDX: Stooq is behind a
JavaScript proof-of-work, idx.co.id returns Cloudflare 403, and Investing.com
returns 403. The feed is delayed 10 minutes (Yahoo via ICE Data Services), which
is the exchange-mandated floor for free IDX data -- no free source beats it.

Yahoo rate-limits aggressively by IP. Plain HTTP from a datacenter address gets
429 on every request, including US symbols; yfinance's curl_cffi transport
impersonates a real browser's TLS fingerprint and gets through. That, plus the
circuit breaker below, is what keeps ingestion alive.
"""

from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import pandas as pd
import yfinance as yf
from tenacity import (
    AsyncRetrying,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential_jitter,
)
from yfinance.exceptions import YFRateLimitError

from app.core.config import settings
from app.core.logging import get_logger
from app.domain.calendar import WIB, session_day
from app.domain.timeframes import INTRADAY, Timeframe

log = get_logger(__name__)

# Surface failures instead of returning an empty frame. v1's fetcher could not
# tell "no data" from "request failed" and logged both as a thin response.
yf.config.debug.hide_exceptions = False

_INTERVAL: dict[Timeframe, str] = {
    Timeframe.M5: "5m",
    Timeframe.H1: "1h",
    Timeframe.D1: "1d",
}

#: A bar is only final once its close is this far behind wall clock: 10 minutes
#: of feed delay plus slack. Until then it is still being revised and must be
#: re-upserted on the next poll.
FINALITY_MARGIN = timedelta(minutes=15)


class SymbolNotFound(Exception):
    """Yahoo has no such ticker. Never retried."""


class RateLimited(Exception):
    """Yahoo returned 429. Retried, and trips the circuit breaker."""


class TransientFetchError(Exception):
    """Network blip or 5xx. Retried."""


@dataclass(frozen=True, slots=True)
class Bar:
    ts: datetime  # bucket OPEN time, tz-aware UTC
    o: float
    h: float
    l: float
    c: float
    v: int | None
    final: bool


def to_yahoo_symbol(symbol: str) -> str:
    """``BBCA`` -> ``BBCA.JK``; index symbols like ``^JKSE`` pass through."""
    s = symbol.strip().upper()
    if s.startswith("^") or "." in s:
        return s
    return f"{s}.JK"


def to_base_symbol(yahoo_symbol: str) -> str:
    s = yahoo_symbol.strip().upper()
    return s[:-3] if s.endswith(".JK") else s


def is_index(symbol: str) -> bool:
    return symbol.strip().startswith("^")


def _status_code(exc: BaseException) -> int | None:
    for attr in ("status_code", "code"):
        val = getattr(exc, attr, None)
        if isinstance(val, int):
            return val
    resp = getattr(exc, "response", None)
    if resp is not None:
        val = getattr(resp, "status_code", None)
        if isinstance(val, int):
            return val
    return None


def _classify(exc: BaseException) -> Exception:
    """Map a yfinance/transport error onto our retry policy.

    v1 retried everything on one path and nothing on the other. The distinction
    that matters: 429 and 5xx are worth retrying, 404 never is.
    """
    if isinstance(exc, YFRateLimitError):
        return RateLimited(str(exc))

    status = _status_code(exc)
    if status == 429:
        return RateLimited(f"HTTP 429: {exc}")
    if status in (404, 422):
        return SymbolNotFound(f"HTTP {status}: {exc}")
    if status is not None and 500 <= status < 600:
        return TransientFetchError(f"HTTP {status}: {exc}")

    text = str(exc).lower()
    if "too many requests" in text or "rate limit" in text:
        return RateLimited(str(exc))
    if "404" in text or "delisted" in text or "no data found" in text:
        return SymbolNotFound(str(exc))
    return TransientFetchError(f"{type(exc).__name__}: {exc}")


class CircuitBreaker:
    """Stops hammering Yahoo once it starts refusing us.

    Rate limiting here is a real, observed failure mode rather than a theoretical
    one, so tripping fast and waiting matters more than squeezing out retries.
    """

    def __init__(self, threshold: int, cooldown_s: int) -> None:
        self._threshold = threshold
        self._cooldown = timedelta(seconds=cooldown_s)
        self._consecutive = 0
        self._opened_at: datetime | None = None

    @property
    def is_open(self) -> bool:
        if self._opened_at is None:
            return False
        if datetime.now(UTC) - self._opened_at >= self._cooldown:
            self._opened_at = None
            self._consecutive = 0
            return False
        return True

    @property
    def state(self) -> dict[str, object]:
        return {
            "open": self.is_open,
            "consecutive_rate_limits": self._consecutive,
            "opened_at": self._opened_at.isoformat() if self._opened_at else None,
            "reopens_at": (
                (self._opened_at + self._cooldown).isoformat() if self._opened_at else None
            ),
        }

    def record_success(self) -> None:
        self._consecutive = 0

    def record_rate_limit(self) -> None:
        self._consecutive += 1
        if self._consecutive >= self._threshold and self._opened_at is None:
            self._opened_at = datetime.now(UTC)
            log.warning("yahoo.breaker_open", consecutive=self._consecutive)

    def reset(self) -> None:
        self._consecutive = 0
        self._opened_at = None


class YahooSource:
    def __init__(self) -> None:
        self.breaker = CircuitBreaker(settings.breaker_threshold, settings.breaker_cooldown_s)
        self._sem = asyncio.Semaphore(settings.fetch_concurrency)

    async def fetch(
        self,
        symbol: str,
        timeframe: Timeframe,
        *,
        period: str | None = None,
        start: datetime | None = None,
        end: datetime | None = None,
        now: datetime | None = None,
    ) -> list[Bar]:
        """Fetch bars for one symbol/timeframe. Returns [] when Yahoo has none."""
        if timeframe not in _INTERVAL:
            raise ValueError(f"{timeframe} is not a base timeframe; it must be resampled")
        if self.breaker.is_open:
            raise RateLimited("circuit breaker open")

        yahoo_symbol = to_yahoo_symbol(symbol)
        df = await self._fetch_frame(
            yahoo_symbol, _INTERVAL[timeframe], period=period, start=start, end=end
        )
        return self._to_bars(df, symbol, timeframe, now=now or datetime.now(UTC))

    async def probe(self, symbol: str) -> dict[str, object]:
        """Validate a ticker before subscribing to it, and grab its display name."""
        yahoo_symbol = to_yahoo_symbol(symbol)
        bars = await self.fetch(symbol, Timeframe.D1, period="5d")
        if not bars:
            raise SymbolNotFound(f"{yahoo_symbol} returned no price data")
        name = await asyncio.to_thread(self._sync_name, yahoo_symbol)
        return {
            "yahoo_symbol": yahoo_symbol,
            "name": name,
            "kind": "index" if is_index(symbol) else "stock",
            "last_close": bars[-1].c,
        }

    @staticmethod
    def _sync_name(yahoo_symbol: str) -> str | None:
        try:
            info = yf.Ticker(yahoo_symbol).info or {}
            return info.get("longName") or info.get("shortName")
        except Exception:  # noqa: BLE001 - a missing display name must not block subscribing
            return None

    async def _fetch_frame(
        self,
        yahoo_symbol: str,
        interval: str,
        *,
        period: str | None,
        start: datetime | None,
        end: datetime | None,
    ) -> pd.DataFrame:
        attempts = settings.fetch_max_attempts
        async for attempt in AsyncRetrying(
            stop=stop_after_attempt(attempts),
            wait=wait_exponential_jitter(initial=2, max=30),
            retry=retry_if_exception_type((RateLimited, TransientFetchError)),
            reraise=True,
        ):
            with attempt:
                async with self._sem:
                    # Spread concurrent calls out slightly; bursts are what trip
                    # Yahoo's per-IP limiter.
                    await asyncio.sleep(random.uniform(0, settings.fetch_jitter_ms / 1000))
                    try:
                        df = await asyncio.wait_for(
                            asyncio.to_thread(
                                self._sync_history,
                                yahoo_symbol,
                                interval,
                                period,
                                start,
                                end,
                            ),
                            timeout=settings.fetch_timeout_s,
                        )
                    except TimeoutError as exc:
                        raise TransientFetchError(
                            f"timeout after {settings.fetch_timeout_s}s"
                        ) from exc
                    except (SymbolNotFound, RateLimited, TransientFetchError):
                        raise
                    except Exception as exc:
                        mapped = _classify(exc)
                        if isinstance(mapped, RateLimited):
                            self.breaker.record_rate_limit()
                        raise mapped from exc

                self.breaker.record_success()
                return df
        return pd.DataFrame()

    @staticmethod
    def _sync_history(
        yahoo_symbol: str,
        interval: str,
        period: str | None,
        start: datetime | None,
        end: datetime | None,
    ) -> pd.DataFrame:
        ticker = yf.Ticker(yahoo_symbol)
        kwargs: dict[str, object] = {"interval": interval, "auto_adjust": False}
        if start is not None or end is not None:
            kwargs["start"] = start
            kwargs["end"] = end
        else:
            kwargs["period"] = period or "1d"
        df = ticker.history(**kwargs)
        if df is None:
            return pd.DataFrame()
        return df

    def _to_bars(
        self, df: pd.DataFrame, symbol: str, timeframe: Timeframe, *, now: datetime
    ) -> list[Bar]:
        if df is None or df.empty:
            return []

        cols = {c.lower(): c for c in df.columns}
        required = ("open", "high", "low", "close")
        if any(c not in cols for c in required):
            log.warning("yahoo.unexpected_columns", symbol=symbol, columns=list(df.columns))
            return []

        # Indices report volume as a literal 0 on intraday intervals but carry
        # real volume on 1d (verified on ^JKSE). Storing those zeros would render
        # an empty volume pane that looks like missing data, so they become null.
        drop_volume = is_index(symbol) and timeframe in INTRADAY

        frame = df.dropna(subset=[cols["close"]])
        volume_col = cols.get("volume")
        cutoff = now - FINALITY_MARGIN
        today = session_day(now)
        width = self._bar_width(timeframe)

        bars: list[Bar] = []
        for ts, row in frame.iterrows():
            ts = pd.Timestamp(ts)
            if ts.tzinfo is None:
                ts = ts.tz_localize(WIB)
            ts_utc = ts.tz_convert("UTC").to_pydatetime()

            if timeframe is Timeframe.D1:
                # Daily bars are stamped at WIB midnight; they settle once the
                # session day is behind us.
                final = session_day(ts_utc) < today
            else:
                final = (ts_utc + width) <= cutoff

            volume: int | None = None
            if volume_col is not None and not drop_volume:
                raw = row[volume_col]
                volume = 0 if pd.isna(raw) else int(raw)

            bars.append(
                Bar(
                    ts=ts_utc,
                    o=float(row[cols["open"]]),
                    h=float(row[cols["high"]]),
                    l=float(row[cols["low"]]),
                    c=float(row[cols["close"]]),
                    v=volume,
                    final=final,
                )
            )
        return bars

    @staticmethod
    def _bar_width(timeframe: Timeframe) -> timedelta:
        return {
            Timeframe.M5: timedelta(minutes=5),
            Timeframe.H1: timedelta(hours=1),
        }.get(timeframe, timedelta(days=1))


yahoo = YahooSource()

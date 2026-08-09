# Lixionary Stock v2 — Backend

IDX (Indonesia Stock Exchange) OHLCV ingestion and analytics backend. Pulls
5-minute, hourly and daily bars for a subscribed watchlist plus the IHSG index,
stores raw OHLCV in MongoDB, and serves any timeframe from 5m to 1d.

## Data source and the delay floor

**10 minutes is a hard floor** for free IDX market data. Yahoo Finance lists the
Indonesia Stock Exchange at a 10-minute delay (provider: ICE Data Services), and
TradingView independently reports `delayed_streaming_600` for the same exchange.
Nothing free beats it — real-time IDX is a paid exchange licence.

Yahoo is the only free source that still works. Verified during design:

| Source | Status |
|---|---|
| Yahoo Finance | ✅ works (via `yfinance` + curl_cffi) |
| Stooq | ❌ JavaScript proof-of-work challenge |
| idx.co.id | ❌ Cloudflare 403 |
| Investing.com | ❌ 403 |
| Sectors.app v1 | ❌ discontinued 2026-05-11 |

**Yahoo rate-limits by IP.** Plain HTTP from a datacenter address gets `429` on
every request, including US symbols. `yfinance`'s curl_cffi transport
impersonates a real browser's TLS fingerprint and gets through — but a
residential/home connection is still the reliable place to run this, which is why
it targets a mini PC on Tailscale rather than a cloud VM.

### Verified Yahoo limits

| Interval | Max lookback | Evidence |
|---|---|---|
| 5m | ~60 days | `range=3mo` → HTTP 422 |
| 1h | ~730 days | `range=2y` → 2,880 bars |
| 1d | full history | `^JKSE` goes back to 1990 |

The 5m window is perishable: intraday history older than 60 days is
**unrecoverable**. That is the core reason this service persists its own bars.

## Design

**Three base timeframes are fetched and stored — 5m, 1h, 1d. Everything else is
resampled on read.** Derived series can never drift from their source, and
changing the bucketing rules needs no backfill.

| Timeframe | Served from |
|---|---|
| 5m | stored 5m |
| 15m, 30m | resampled from 5m |
| 1h | stored 1h, or 5m when it reaches far enough |
| 2h, 4h | resampled from 5m, falling back to 1h for deeper history |
| 1d | stored 1d — never derived from intraday |

Daily is never resampled from intraday: Yahoo's 1d bar carries the closing
auction and split/dividend adjustment, neither reconstructable from 5m bars.

### Session-aligned bucketing

Every intraday bucket is anchored to **09:00 WIB** and never spans a trading day.
IDX sessions (verified against live 5m data):

| | Session I | Session II | Auction |
|---|---|---|---|
| Mon–Thu | 09:00–12:00 | 13:30–15:49 | 15:50–16:15 |
| Fri | 09:00–11:30 | 14:00–15:49 | 15:50–16:15 |

Yahoo omits the lunch break entirely rather than emitting empty bars, so buckets
inside it never materialise. Resulting layout on a Mon–Thu session:

```
1h   09:00 10:00 11:00 13:00 14:00 15:00 16:00     (no 12:00 — lunch)
2h   09:00 11:00 13:00 15:00
4h   09:00 13:00
```

### Storage

`candles` is a regular collection with a **unique index on
`(symbol, timeframe, ts)`**, not a Mongo time-series collection — time-series
collections don't support unique indexes, and idempotent upsert is essential
because the most recent bar is still forming while the delayed feed catches up.

**Only raw OHLCV is stored.** No indicators. (v1 baked RSI/MACD/EMA into each bar
and *dropped* rows still in indicator warmup, which permanently truncated history
and made indicator periods unchangeable.)

`ts` is always the bucket **open** time, tz-aware UTC.

## Running it

```bash
cp .env.example .env      # set MONGO_PASSWORD
docker compose up -d --build
```

Three containers: `mongo` (auth on, bound to `127.0.0.1:8852`), `api`
(`127.0.0.1:8850`), and `worker`. The scheduler lives in `worker`, not in the API
lifespan, so restarting the API never interrupts ingestion.

Seed a watchlist:

```bash
cd backend
python scripts/seed_symbols.py --file watchlist.example.txt
# or
python scripts/seed_symbols.py BBCA BBRI TLKM ^JKSE
```

### Windows mini PC + Tailscale

Nothing is published to the public internet — both ports bind to loopback.
Expose the API to your tailnet with:

```
tailscale serve --bg 8850
```

That gives TLS and a stable MagicDNS name with no firewall rules to maintain.

### Production Nginx Reverse Proxy Deployment

To deploy this service publicly (e.g., at `stockv2.lixionary.com`), configure an Nginx reverse proxy pointing to the frontend port (`8850` on the host).

1. Copy the Nginx configuration template from `nginx/stockv2.lixionary.com.conf.example` to `/etc/nginx/sites-available/stockv2.lixionary.com.conf`.
2. Enable the configuration by creating a symlink:
   ```bash
   sudo ln -s /etc/nginx/sites-available/stockv2.lixionary.com.conf /etc/nginx/sites-enabled/
   ```
3. Test syntax and reload Nginx:
   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```
4. Secure the site with HTTPS using Certbot:
   ```bash
   sudo certbot --nginx -d stockv2.lixionary.com
   ```

> [!IMPORTANT]
> To ensure Google SSO OAuth redirects do not resolve to internal Docker container IDs/ports, make sure:
> - Nginx is forwarding `X-Forwarded-Host` and `X-Forwarded-Port`.
> - The environment variables `AUTH_TRUST_HOST=true`, `AUTH_URL`, and `AUTH_REDIRECT_PROXY_URL` are properly set in the `docker-compose.yml` frontend service environment.

## Scheduled jobs

| Job | Cadence | Work |
|---|---|---|
| `poll_5m` | every 5 min, session-gated | 5m bars, `period=2d` |
| `refresh_1h` | :02 and :32, session-gated | 1h bars, `period=5d` |
| `close_of_day` | 16:30 WIB Mon–Fri | 1d + 1h, `period=1mo`, recalc coverage |
| `nightly_daily` | 02:00 WIB | 1d `period=6mo` — picks up restatements |
| `coverage_recalc` | 03:00 WIB | refresh per-symbol coverage |

The session gate lives in the job, not the trigger, so the window logic sits in
one place. Poll window is **09:00–16:30 WIB** — a 15-minute tail past close so the
10-minute-delayed final bars still land. Outside it the job no-ops immediately.

Roughly **2,700 requests/day** for 30 symbols, session hours only. Concurrency is
capped at 4 with jitter; a circuit breaker halts all fetching after 5 consecutive
rate-limit errors and surfaces on `/api/system/health`.

Holidays live in `app/data/idx_holidays.json`, derived from real gaps in Yahoo's
daily series (2023–2026) plus fixed-date national holidays. Indonesia's calendar
is largely lunar, so it needs a yearly top-up — but a missing entry only costs a
few no-op polls, never bad data.

## API

No authentication in this phase.

### Symbols
| Method | Path | |
|---|---|---|
| GET | `/api/symbols` | `?enabled=` |
| POST | `/api/symbols` | validates upstream, 409 if duplicate, auto-backfills |
| GET | `/api/symbols/{symbol}` | detail + coverage |
| PATCH | `/api/symbols/{symbol}` | `{enabled, name, notes}` |
| DELETE | `/api/symbols/{symbol}` | `?purge=true` also deletes candles (irreversible) |
| POST | `/api/symbols/{symbol}/backfill` | returns `run_id` |

### Candles
```
GET /api/candles/{symbol}?timeframe=15m&from=&to=&limit=
```
Returns `source_timeframe` and `derived` so you can see which base actually
served the request, and `has_volume` — the IHSG has **no volume at 5m/1h but real
volume at 1d**, so the frontend must hide the volume pane per timeframe.

Index symbols need URL-encoding: `^JKSE` → `%5EJKSE`.

### System
`GET /api/system/health`, `/session`, `/runs`, `POST /api/system/poll`.
Every mutating endpoint returns a `run_id` immediately and never blocks.

## Tests

```bash
cd backend && .venv/bin/python -m pytest tests/ -q     # 51 tests
```

Covers the calendar (holiday runs, Friday's shorter session, window boundaries)
and the resampler (bucket anchoring, no cross-day or cross-lunch buckets, exact
OHLCV aggregation, finality propagation, and that 4h built from 5m equals 4h built
from 1h — the property that makes source fallback seam-free).

## Not in this phase

Indicators (to be computed on read, never stored), AI analysis, authentication,
the Next.js frontend, and IHSG volume via constituent summation.

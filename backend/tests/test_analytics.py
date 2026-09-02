import json

from app.services.analytics import normalize_plan, parse_analysis_response


def test_normalize_plan():
    last_price = 6300.0

    # Valid plan
    raw = {
        "entry": 6250.0,
        "stop": 6000.0,
        "target": 6800.0,
        "basis": "entry on pullback, stop below support",
    }
    plan = normalize_plan(raw, last_price)
    assert plan is not None
    assert plan["entry"] == 6250.0
    assert plan["stop"] == 6000.0
    assert plan["target"] == 6800.0
    assert plan["rr"] is not None
    assert plan["rr"] > 1.0

    # Incoherent stop (stop >= entry) -> dropped stop
    raw_bad_stop = {"entry": 6250.0, "stop": 6300.0, "target": 6800.0}
    plan_bad_stop = normalize_plan(raw_bad_stop, last_price)
    assert plan_bad_stop is not None
    assert plan_bad_stop["stop"] is None

    # Distant hallucinated level (> 40% away) -> dropped
    raw_hallucination = {"entry": 15000.0, "stop": 2000.0, "target": 20000.0}
    plan_hallucination = normalize_plan(raw_hallucination, last_price)
    assert plan_hallucination is None


def test_parse_analysis_response():
    sample_json = {
        "stance": "bullish",
        "summary": "BBCA shows solid consolidation above the cloud.",
        "bullets": ["Trading above cloud top", "RSI neutral at 58", "Tenkan above Kijun"],
        "risks": ["Break below 6000 support"],
        "trade_plan": {
            "entry": 6250,
            "stop": 6000,
            "target": 6800,
            "basis": "entry on pullback",
        },
    }
    raw = f"```json\n{json.dumps(sample_json)}\n```"
    parsed = parse_analysis_response(raw, 6300.0)
    assert parsed["stance"] == "bullish"
    assert len(parsed["bullets"]) == 3
    assert parsed["plan"] is not None
    assert parsed["plan"]["entry"] == 6250.0


from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch
import pytest
from app.services.analytics import get_recent_news_for_symbol
from app.worker.scheduler import build_scheduler
from app.worker.jobs import run_post_market_cycle


@pytest.mark.asyncio
async def test_get_recent_news_for_symbol():
    now = datetime(2026, 9, 2, 17, 0, 0, tzinfo=UTC)
    mock_db = MagicMock()

    sample_doc = {
        "title": "BBCA records 15% profit jump",
        "summary": "Bank Central Asia posts record earnings...",
        "published_at": now - timedelta(days=2),
        "analysis": {
            "relevant": True,
            "sentiment": "bullish",
            "impact": "high",
            "note": "Positive financial results",
            "symbols": [
                {"symbol": "BBCA", "direction": "positive", "reason": "strong earnings growth"}
            ],
        },
    }

    class MockCursor:
        def __init__(self, docs):
            self.docs = docs
        def sort(self, *args, **kwargs):
            return self
        def limit(self, *args, **kwargs):
            return self
        def __aiter__(self):
            return self._gen()
        async def _gen(self):
            for d in self.docs:
                yield d

    mock_db.news_items.find.return_value = MockCursor([sample_doc])

    news = await get_recent_news_for_symbol(mock_db, "BBCA", now, days=7, limit=5)
    assert len(news) == 1
    assert news[0]["title"] == "BBCA records 15% profit jump"
    assert news[0]["market_sentiment"] == "bullish"
    assert news[0]["direction"] == "positive"
    assert news[0]["reason"] == "strong earnings growth"

    # Verify query criteria
    mock_db.news_items.find.assert_called_once()
    query = mock_db.news_items.find.call_args[0][0]
    assert query["analysis.relevant"] is True
    assert query["analysis.symbols.symbol"] == "BBCA"
    assert query["published_at"]["$gte"] == now - timedelta(days=7)


def test_scheduler_post_market_job():
    scheduler = build_scheduler()
    job = scheduler.get_job("post_market_cycle")
    assert job is not None
    # Verify it runs at 17:00
    trigger_str = str(job.trigger)
    assert "hour='17'" in trigger_str
    assert "minute='0'" in trigger_str
    assert "day_of_week='mon-fri'" in trigger_str


@pytest.mark.asyncio
async def test_run_post_market_cycle():
    mock_db = MagicMock()
    with patch("app.services.analytics.run_stockpicks_analytics", new_callable=AsyncMock) as mock_analytics, \
         patch("app.services.recommendations.run_portfolio_recommendations", new_callable=AsyncMock) as mock_rec:
        mock_analytics.return_value = {"status": "ok"}
        mock_rec.return_value = {"status": "ok"}

        res = await run_post_market_cycle(mock_db, force=True)
        assert res["analytics"] == {"status": "ok"}
        assert res["recommendations"] == {"status": "ok"}

        mock_analytics.assert_awaited_once_with(mock_db, slot="post_market", force=True)
        mock_rec.assert_awaited_once_with(mock_db, slot="post_market", force=True)


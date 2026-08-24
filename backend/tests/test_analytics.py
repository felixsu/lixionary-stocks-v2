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

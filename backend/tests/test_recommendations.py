import json

from app.services.recommendations import parse_recommendations_response


def test_parse_recommendations_response():
    sample = {
        "positions": [
            {
                "symbol": "BBCA",
                "action": "hold",
                "summary": "Solid position with strong technical structure.",
                "reasons": ["Above 20 EMA", "RSI neutral"],
            },
            {
                "symbol": "CUAN",
                "action": "cut_loss",
                "summary": "Breakdown below structural support.",
                "reasons": ["MACD bearish cross", "Downtrend confirmed"],
            },
        ],
        "portfolio_note": "Portfolio has healthy 40% cash allocation and controlled risk.",
    }
    raw = f"```json\n{json.dumps(sample)}\n```"
    parsed = parse_recommendations_response(raw)
    assert len(parsed["positions"]) == 2
    assert parsed["positions"][0]["symbol"] == "BBCA"
    assert parsed["positions"][0]["action"] == "hold"
    assert parsed["positions"][1]["action"] == "cut_loss"
    assert "healthy" in parsed["portfolio_note"]

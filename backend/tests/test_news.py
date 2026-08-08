from app.services.news import parse_analysis_response
from app.sources.rss import normalize_entries

FEED_XML = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Test Ekonomi</title>
  <item>
    <title>Harga BBM naik, &lt;b&gt;pasar&lt;/b&gt; bergejolak</title>
    <link>https://example.com/a</link>
    <guid>guid-a</guid>
    <pubDate>Fri, 08 Aug 2026 10:00:00 +0700</pubDate>
    <description><![CDATA[<p>Kenaikan harga BBM &amp; dampaknya…</p>]]></description>
  </item>
  <item>
    <title>Item without guid or date</title>
    <link>https://example.com/b</link>
  </item>
  <item>
    <title>No link — must be skipped</title>
  </item>
</channel></rss>"""


class TestNormalizeEntries:
    def test_parses_and_cleans(self):
        items = normalize_entries(FEED_XML, "https://www.antaranews.com/rss/ekonomi.xml", "finance")
        assert len(items) == 2  # the linkless item is dropped

        a = items[0]
        # HTML tags and entities stripped from title and summary
        assert a["title"] == "Harga BBM naik, pasar bergejolak"
        assert "<p>" not in a["summary"] and "&amp;" not in a["summary"]
        assert a["guid"] == "guid-a"
        assert a["feed_category"] == "finance"
        assert a["source"] == "antaranews.com"
        # pubDate with +0700 offset converts to UTC
        assert a["published_at"].isoformat().startswith("2026-08-08T03:00:00")

    def test_missing_guid_and_date_get_fallbacks(self):
        items = normalize_entries(FEED_XML, "https://feed.example/x", "market")
        b = items[1]
        assert b["guid"] == "https://example.com/b"  # falls back to link
        assert b["published_at"] is not None  # falls back to fetch time


class TestParseAnalysisResponse:
    VALID_IDS = {0, 1, 2}
    VALID_SYMBOLS = {"BBCA", "TLKM"}

    def test_clean_array(self):
        raw = """[
          {"id": 0, "relevant": true, "sentiment": "bearish", "impact": "high",
           "note": "Fuel price hike pressures consumer names.",
           "symbols": [{"symbol": "BBCA", "direction": "negative", "reason": "rate pressure"}]},
          {"id": 1, "relevant": false, "sentiment": "neutral", "impact": "low", "note": "", "symbols": []}
        ]"""
        out = parse_analysis_response(raw, self.VALID_IDS, self.VALID_SYMBOLS)
        assert out[0]["sentiment"] == "bearish"
        assert out[0]["symbols"] == [
            {"symbol": "BBCA", "direction": "negative", "reason": "rate pressure"}
        ]
        assert out[1]["relevant"] is False

    def test_fenced_response_with_prose(self):
        raw = 'Here is my analysis:\n```json\n[{"id": 2, "relevant": true, "sentiment": "bullish", "impact": "medium", "note": "x", "symbols": []}]\n```\nHope that helps!'
        out = parse_analysis_response(raw, self.VALID_IDS, self.VALID_SYMBOLS)
        assert out[2]["sentiment"] == "bullish"

    def test_invalid_bits_are_dropped_not_fatal(self):
        raw = """[
          {"id": 0, "relevant": true, "sentiment": "MOON", "impact": "extreme",
           "symbols": [
             {"symbol": "GOTO", "direction": "positive", "reason": "not tracked"},
             {"symbol": "TLKM", "direction": "sideways", "reason": "bad direction"},
             {"symbol": "TLKM", "direction": "positive", "reason": "ok"}
           ]},
          {"id": 99, "relevant": true, "sentiment": "bullish", "impact": "low", "symbols": []},
          "garbage entry"
        ]"""
        out = parse_analysis_response(raw, self.VALID_IDS, self.VALID_SYMBOLS)
        assert out[0]["sentiment"] == "neutral"  # unknown value coerced
        assert out[0]["impact"] == "low"
        assert out[0]["symbols"] == [
            {"symbol": "TLKM", "direction": "positive", "reason": "ok"}
        ]  # untracked symbol and bad direction dropped
        assert 99 not in out  # unknown id ignored

    def test_non_array_raises(self):
        import pytest

        with pytest.raises(ValueError):
            parse_analysis_response('{"not": "an array"}', self.VALID_IDS, self.VALID_SYMBOLS)

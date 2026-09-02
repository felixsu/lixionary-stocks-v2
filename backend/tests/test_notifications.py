import uuid
from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.notifications import (
    clear_notifications,
    evaluate_watchlist_price_alerts,
    get_latest_symbol_price,
    get_monitored_targets,
    list_notifications,
    mark_notifications_read,
    remove_custom_target,
    set_custom_target,
    simulate_alert,
)
from app.sources.telegram import format_alert_message, get_telegram_config, send_telegram_message


def test_format_alert_message():
    msg_entry = format_alert_message("BBCA", "entry_hit", 6250.0, 6250.0, name="Bank Central Asia", basis="pullback to kijun")
    assert "ENTRY SETUP HIT: BBCA" in msg_entry
    assert "Bank Central Asia" in msg_entry
    assert "pullback to kijun" in msg_entry

    msg_target = format_alert_message("BBRI", "target_hit", 5100.0, 5000.0, name="Bank Rakyat Indonesia")
    assert "TARGET REACHED: BBRI" in msg_target

    msg_stop = format_alert_message("TLKM", "stop_hit", 2900.0, 3000.0, name="Telkom")
    assert "STOP LOSS TRIGGERED: TLKM" in msg_stop


@pytest.mark.asyncio
async def test_get_telegram_config_fallback():
    mock_db = MagicMock()
    mock_db.settings.find_one = AsyncMock(return_value=None)
    cfg = await get_telegram_config(mock_db)
    assert isinstance(cfg, dict)
    assert "bot_token" in cfg
    assert "chat_id" in cfg


@pytest.mark.asyncio
async def test_send_telegram_message_skipped_when_not_configured():
    mock_db = MagicMock()
    mock_db.settings.find_one = AsyncMock(return_value=None)
    with patch("app.sources.telegram.settings") as mock_settings:
        mock_settings.telegram_bot_token = ""
        mock_settings.telegram_chat_id = ""
        res = await send_telegram_message(mock_db, "test message")
        assert res["status"] == "skipped"


@pytest.mark.asyncio
async def test_send_telegram_message_success():
    mock_db = MagicMock()
    mock_db.settings.find_one = AsyncMock(return_value={"bot_token": "fake:token", "chat_id": "123456"})

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = MagicMock(status_code=200, json=lambda: {"ok": True, "result": {"message_id": 99}})
        res = await send_telegram_message(mock_db, "test text")
        assert res["status"] == "sent"
        assert res["message_id"] == 99


@pytest.mark.asyncio
async def test_set_and_remove_custom_target():
    mock_db = MagicMock()
    mock_db.settings.update_one = AsyncMock()

    res = await set_custom_target(mock_db, "bbca", entry=6100.0, stop=5900.0, target=6700.0, basis="custom pullback")
    assert res["symbol"] == "BBCA"
    assert res["entry"] == 6100.0
    mock_db.settings.update_one.assert_awaited()

    res_del = await remove_custom_target(mock_db, "bbca")
    assert res_del["symbol"] == "BBCA"
    assert res_del["reverted_to_ai"] is True


@pytest.mark.asyncio
async def test_evaluate_watchlist_price_alerts_entry_and_target():
    now = datetime(2026, 9, 2, 10, 30, 0, tzinfo=UTC)  # Wednesday morning trading session
    mock_db = MagicMock()

    monitors = [
        {
            "symbol": "BBCA",
            "name": "Bank Central Asia",
            "current_price": 6200.0,  # below entry of 6250 -> entry_hit
            "entry": 6250.0,
            "target": 6800.0,
            "stop": 6000.0,
            "basis": "kijun support",
            "source": "ai",
            "enabled": True,
            "entry_triggered_today": False,
            "target_triggered_today": False,
            "stop_triggered_today": False,
        },
        {
            "symbol": "BBRI",
            "name": "Bank Rakyat Indonesia",
            "current_price": 5200.0,  # above target of 5100 -> target_hit
            "entry": 4800.0,
            "target": 5100.0,
            "stop": 4600.0,
            "basis": "resistance test",
            "source": "manual",
            "enabled": True,
            "entry_triggered_today": False,
            "target_triggered_today": False,
            "stop_triggered_today": False,
        },
    ]

    with patch("app.services.notifications.get_monitored_targets", new_callable=AsyncMock) as mock_get_monitors, \
         patch("app.services.notifications.send_telegram_message", new_callable=AsyncMock) as mock_tg:
        mock_get_monitors.return_value = monitors
        mock_tg.return_value = {"status": "sent"}
        mock_db.notifications.find_one = AsyncMock(return_value=None)
        mock_db.notifications.insert_one = AsyncMock()

        res = await evaluate_watchlist_price_alerts(mock_db, now=now, force=True)
        assert res["status"] == "ok"
        assert res["triggered_count"] == 2
        assert len(res["alerts"]) == 2

        # Check types triggered
        alert_types = {a["alert_type"] for a in res["alerts"]}
        assert "entry_hit" in alert_types
        assert "target_hit" in alert_types


@pytest.mark.asyncio
async def test_simulate_alert():
    mock_db = MagicMock()
    mock_db.symbols.find_one = AsyncMock(return_value={"name": "Bank Central Asia"})
    mock_db.notifications.insert_one = AsyncMock()

    with patch("app.services.notifications.send_telegram_message", new_callable=AsyncMock) as mock_tg:
        mock_tg.return_value = {"status": "sent"}
        res = await simulate_alert(
            mock_db,
            symbol="BBCA",
            alert_type="entry_hit",
            current_price=6250.0,
            target_price=6250.0,
            basis="Manual simulation test",
            send_telegram=True,
        )
        assert res["symbol"] == "BBCA"
        assert res["alert_type"] == "entry_hit"
        assert res["simulated"] is True
        assert res["telegram_status"] == "sent"
        mock_db.notifications.insert_one.assert_awaited_once()


@pytest.mark.asyncio
async def test_notifications_crud():
    mock_db = MagicMock()

    # List
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

    sample = {"_id": "notif-1", "symbol": "BBCA", "alert_type": "entry_hit", "read": False, "created_at": datetime.now(UTC)}
    mock_db.notifications.find.return_value = MockCursor([sample])
    mock_db.notifications.count_documents = AsyncMock(return_value=1)

    listed = await list_notifications(mock_db)
    assert len(listed["items"]) == 1
    assert listed["unread_count"] == 1

    # Mark read
    mock_db.notifications.update_many = AsyncMock(return_value=MagicMock(modified_count=1))
    read_res = await mark_notifications_read(mock_db, ["notif-1"])
    assert read_res["modified_count"] == 1

    # Clear
    mock_db.notifications.delete_many = AsyncMock(return_value=MagicMock(deleted_count=1))
    clear_res = await clear_notifications(mock_db)
    assert clear_res["deleted_count"] == 1

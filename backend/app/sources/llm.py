"""Worker-side LLM client for news analysis, stock analytics, and portfolio recommendations.

All three supported providers expose OpenAI-compatible chat-completions
endpoints. Configured via LLM_PROVIDER / LLM_MODEL / LLM_API_KEY in the backend
env, or dynamically stored in MongoDB settings ('llm_config').
"""

from __future__ import annotations

from typing import Any

import httpx
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.core.config import settings

BASE_URLS: dict[str, str] = {
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
    "minimax": "https://api.minimax.io/v1",
    "openai": "https://api.openai.com/v1",
}


class LlmNotConfigured(Exception):
    pass


class LlmError(Exception):
    pass


async def get_effective_llm_config(
    db: AsyncIOMotorDatabase | None = None,
) -> dict[str, str]:
    """Retrieve effective LLM configuration from DB settings, fallback to env."""
    if db is not None:
        try:
            doc = await db.settings.find_one({"_id": "llm_config"})
            if doc and doc.get("provider") and doc.get("model") and doc.get("api_key"):
                return {
                    "provider": str(doc["provider"]),
                    "model": str(doc["model"]),
                    "api_key": str(doc["api_key"]),
                }
        except Exception:
            pass

    return {
        "provider": settings.llm_provider,
        "model": settings.llm_model,
        "api_key": settings.llm_api_key,
    }


def is_configured(cfg: dict[str, str] | None = None) -> bool:
    c = cfg or {
        "provider": settings.llm_provider,
        "model": settings.llm_model,
        "api_key": settings.llm_api_key,
    }
    return bool(c.get("provider") in BASE_URLS and c.get("model") and c.get("api_key"))


async def chat(
    messages: list[dict[str, str]],
    *,
    db: AsyncIOMotorDatabase | None = None,
    provider: str | None = None,
    model: str | None = None,
    api_key: str | None = None,
    temperature: float = 0.2,
    timeout: float = 90.0,
) -> str:
    cfg = await get_effective_llm_config(db)
    eff_provider = provider or cfg.get("provider", "")
    eff_model = model or cfg.get("model", "")
    eff_key = api_key or cfg.get("api_key", "")

    if not eff_provider or eff_provider not in BASE_URLS or not eff_model or not eff_key:
        raise LlmNotConfigured(
            "set LLM_PROVIDER (gemini|minimax|openai), LLM_MODEL, and LLM_API_KEY in .env or Settings"
        )

    base = BASE_URLS[eff_provider]
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            f"{base}/chat/completions",
            headers={"Authorization": f"Bearer {eff_key}"},
            json={
                "model": eff_model,
                "messages": messages,
                "temperature": temperature,
            },
        )
    if resp.status_code != 200:
        raise LlmError(f"provider returned HTTP {resp.status_code}: {resp.text[:300]}")
    data: dict[str, Any] = resp.json()
    content = (data.get("choices") or [{}])[0].get("message", {}).get("content")
    if not content:
        raise LlmError("provider returned an empty response")
    return str(content)

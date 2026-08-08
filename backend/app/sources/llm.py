"""Worker-side LLM client for news analysis.

All three supported providers expose OpenAI-compatible chat-completions
endpoints (mirrors the frontend's registry). Configured via LLM_PROVIDER /
LLM_MODEL / LLM_API_KEY in the backend env; unset means fetch-only mode.
"""

from __future__ import annotations

import httpx

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


def is_configured() -> bool:
    return settings.llm_configured and settings.llm_provider in BASE_URLS


async def chat(messages: list[dict[str, str]], *, timeout: float = 90.0) -> str:
    if not is_configured():
        raise LlmNotConfigured(
            "set LLM_PROVIDER (gemini|minimax|openai), LLM_MODEL, and LLM_API_KEY"
        )
    base = BASE_URLS[settings.llm_provider]
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            f"{base}/chat/completions",
            headers={"Authorization": f"Bearer {settings.llm_api_key}"},
            json={
                "model": settings.llm_model,
                "messages": messages,
                "temperature": 0.2,
            },
        )
    if resp.status_code != 200:
        raise LlmError(f"provider returned HTTP {resp.status_code}: {resp.text[:300]}")
    data = resp.json()
    content = (data.get("choices") or [{}])[0].get("message", {}).get("content")
    if not content:
        raise LlmError("provider returned an empty response")
    return content

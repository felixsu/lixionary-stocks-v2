// LLM proxy. App route handlers take precedence over next.config rewrites, so
// /api/llm is served here while every other /api/* path still proxies to the
// FastAPI backend.
//
// This exists purely to sidestep browser CORS on the provider APIs. The API key
// arrives from the browser per request (it lives in localStorage) and is
// forwarded verbatim — never stored, never logged.

import { NextRequest, NextResponse } from "next/server";

const PROVIDER_BASE_URLS: Record<string, string> = {
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  minimax: "https://api.minimax.io/v1",
  openai: "https://api.openai.com/v1",
};

const TIMEOUT_MS = 60_000;

interface ProxyBody {
  action?: "chat" | "models";
  provider?: string;
  apiKey?: string;
  model?: string;
  messages?: { role: string; content: string }[];
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: ProxyBody;
  try {
    body = (await req.json()) as ProxyBody;
  } catch {
    return NextResponse.json({ detail: "invalid JSON body" }, { status: 400 });
  }

  const baseUrl = PROVIDER_BASE_URLS[body.provider ?? ""];
  if (!baseUrl) {
    return NextResponse.json(
      { detail: `unknown provider; expected one of ${Object.keys(PROVIDER_BASE_URLS).join(", ")}` },
      { status: 400 },
    );
  }
  if (!body.apiKey) {
    return NextResponse.json({ detail: "missing apiKey" }, { status: 400 });
  }

  const headers = {
    Authorization: `Bearer ${body.apiKey}`,
    "Content-Type": "application/json",
  };

  try {
    let upstream: Response;
    if (body.action === "models") {
      upstream = await fetch(`${baseUrl}/models`, {
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } else if (body.action === "chat") {
      if (!body.model || !Array.isArray(body.messages) || !body.messages.length) {
        return NextResponse.json({ detail: "chat requires model and messages" }, { status: 400 });
      }
      upstream = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: body.model,
          messages: body.messages,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } else {
      return NextResponse.json({ detail: "action must be 'chat' or 'models'" }, { status: 400 });
    }

    // Pass the provider's response through, status and all, so auth errors and
    // rate limits surface to the UI unaltered.
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return NextResponse.json(
      { detail: timedOut ? `provider did not respond within ${TIMEOUT_MS / 1000}s` : "could not reach provider" },
      { status: 502 },
    );
  }
}

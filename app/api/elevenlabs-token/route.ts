// app/api/elevenlabs-token/route.ts
//
// Mints a short-lived, single-use ElevenLabs Scribe v2 Realtime token for the
// browser, so the client can open the STT WebSocket directly without ever
// seeing the permanent ELEVENLABS_API_KEY. Mirrors app/api/inworld-token/route.ts.

import { NextResponse } from "next/server";
import { SlidingWindow } from "@/lib/rate-limit";
import {
  ElevenLabsConfigError,
  ElevenLabsTokenError,
  mintElevenLabsToken,
} from "@/lib/elevenlabs-auth";

// Never cache: every client needs a fresh, short-lived token.
export const dynamic = "force-dynamic";

// Global concurrency guard, matching the Inworld route. The server never sees
// a session end (the browser talks to ElevenLabs directly), so every issued
// token counts as an active session until its window expires.
const MAX_ACTIVE_SESSIONS = 5;
const SESSION_TTL_MS = 600_000;
const activeSessions = new SlidingWindow(MAX_ACTIVE_SESSIONS, SESSION_TTL_MS);

export async function GET() {
  if (!activeSessions.tryHit()) {
    return NextResponse.json(
      {
        error:
          "All demo slots are in use right now. Try again in a few minutes.",
      },
      {
        status: 429,
        headers: { "Retry-After": "60", "Cache-Control": "no-store" },
      }
    );
  }

  try {
    const { token, expiresAt } = await mintElevenLabsToken();
    return NextResponse.json(
      { token, expiresAt },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    // Log the real cause server-side; return a generic error to the client so
    // we never echo credentials or upstream error text.
    if (
      err instanceof ElevenLabsConfigError ||
      err instanceof ElevenLabsTokenError
    ) {
      console.error(`[elevenlabs-token] ${err.name}: ${err.message}`);
    } else {
      console.error("[elevenlabs-token] Unexpected error", err);
    }
    return NextResponse.json(
      { error: "Failed to generate token" },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}

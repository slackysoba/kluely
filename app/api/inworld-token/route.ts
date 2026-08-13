// app/api/inworld-token/route.ts
//
// Mints a short-lived Inworld session token for the browser, so the client can
// open the STT WebSocket directly without ever seeing the permanent Inworld
// key/secret. Mirrors app/api/token/route.ts (the AssemblyAI equivalent): the
// worst-case leak is one short streaming session, not the account credential.
//
// The browser passes the returned token on the STT socket via the query
// string, e.g.
//   wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional?authorization=Bearer%20<token>

import { NextResponse } from "next/server";
import { SlidingWindow } from "@/lib/rate-limit";
import {
  InworldConfigError,
  InworldTokenError,
  mintInworldToken,
} from "@/lib/inworld-auth";

// Never cache: every client needs a fresh, short-lived token.
export const dynamic = "force-dynamic";

// Global concurrency guard, matching the AssemblyAI route. The server never
// sees a session end (the browser talks to Inworld directly), so every issued
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
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }

  try {
    const { token, expiresAt } = await mintInworldToken();
    return NextResponse.json({ token, expiresAt });
  } catch (err) {
    // Log the real cause server-side; return a generic error to the client so
    // we never echo credentials or upstream error text.
    if (err instanceof InworldConfigError || err instanceof InworldTokenError) {
      console.error(`[inworld-token] ${err.name}: ${err.message}`);
    } else {
      console.error("[inworld-token] Unexpected error", err);
    }
    return NextResponse.json(
      { error: "Failed to generate token" },
      { status: 500 }
    );
  }
}

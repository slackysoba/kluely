// app/api/token/route.ts
//
// Generates a short-lived AssemblyAI streaming token for the browser.
// The permanent API key must never be shipped to the client — anyone could
// extract it and run transcription on our account. Instead, the server
// exchanges the key for a single-use temporary token that expires quickly,
// so the worst-case leak is one short streaming session.

import { NextResponse } from "next/server";
import { SlidingWindow } from "@/lib/rate-limit";

// Never cache this route — every client needs a fresh, single-use token.
export const dynamic = "force-dynamic";

// Global concurrency guard. The server never sees a session end (the
// browser talks to AssemblyAI directly), so we bound concurrency
// conservatively: every issued token counts as an active session for the
// full 10-minute cap we put on it below. At most MAX_ACTIVE_SESSIONS
// AssemblyAI connections can exist at once; sessions that end early just
// hold their slot until the window expires.
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

  const apiKey = process.env.ASSEMBLYAI_API_KEY;

  // Fail generically: never echo the key or upstream error text to the client.
  if (!apiKey) {
    return NextResponse.json(
      { error: "Failed to generate token" },
      { status: 500 }
    );
  }

  const url = new URL("https://streaming.assemblyai.com/v3/token");
  // Token redemption window: client has 60s to open the WebSocket.
  url.searchParams.set("expires_in_seconds", "60");
  // Cap the resulting streaming session at 10 minutes.
  url.searchParams.set("max_session_duration_seconds", "600");

  try {
    const response = await fetch(url, {
      headers: { Authorization: apiKey },
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: "Failed to generate token" },
        { status: 500 }
      );
    }

    const { token } = (await response.json()) as { token: string };
    return NextResponse.json({ token });
  } catch {
    return NextResponse.json(
      { error: "Failed to generate token" },
      { status: 500 }
    );
  }
}

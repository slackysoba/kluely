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

export async function GET(request: Request) {
  // TEMPORARY diagnostic — remove after debugging the production 500.
  // Reports only presence/lengths/structure and the error class, never the
  // key/secret values, so it's safe to hit on the live deployment.
  if (new URL(request.url).searchParams.get("diag") === "1") {
    return diagnose();
  }

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

// TEMPORARY. Safe to expose: no key/secret characters are returned — only
// whether the var is present, its length, whether it decodes to a
// "<keyId>:<secret>" pair (and the lengths of each half), and which error
// class the mint throws. Delete this function and the ?diag branch once fixed.
async function diagnose(): Promise<NextResponse> {
  const raw = process.env.INWORLD_API_KEY;
  const present = typeof raw === "string" && raw.length > 0;
  const trimmed = (raw ?? "").trim();
  const hasSurroundingQuotes = /^["'].*["']$/.test(trimmed);

  let base64DecodesToPair = false;
  let keyIdLength: number | null = null;
  let secretLength: number | null = null;
  if (present) {
    try {
      const decoded = Buffer.from(trimmed, "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      if (idx > 0) {
        keyIdLength = idx;
        secretLength = decoded.length - idx - 1;
        base64DecodesToPair = keyIdLength > 0 && secretLength > 0;
      }
    } catch {
      // leave base64DecodesToPair false
    }
  }

  let mintOk = false;
  let errorClass: string | null = null;
  let errorMessage: string | null = null;
  try {
    await mintInworldToken();
    mintOk = true;
  } catch (err) {
    errorClass = err instanceof Error ? err.name : "Unknown";
    // These messages carry no secret: config errors are static; token errors
    // carry Inworld's own rejection text and HTTP status, not our credentials.
    errorMessage = err instanceof Error ? err.message.slice(0, 300) : String(err);
  }

  return NextResponse.json({
    diag: true,
    env: {
      inworldPresent: present,
      inworldRawLength: raw?.length ?? 0,
      inworldTrimmedLength: trimmed.length,
      inworldHasSurroundingQuotes: hasSurroundingQuotes,
      // Sanity check that env vars reach this function at all:
      assemblyaiPresent: !!process.env.ASSEMBLYAI_API_KEY,
      geminiPresent: !!process.env.GEMINI_API_KEY,
    },
    decode: { base64DecodesToPair, keyIdLength, secretLength },
    mint: { ok: mintOk, errorClass, errorMessage },
  });
}

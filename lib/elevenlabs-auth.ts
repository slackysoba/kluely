// lib/elevenlabs-auth.ts
//
// Server-only. Mints a short-lived ElevenLabs single-use token for Scribe v2
// Realtime STT, so the browser can open the STT WebSocket directly without
// ever seeing the permanent ELEVENLABS_API_KEY. Mirrors lib/inworld-auth.ts:
// the permanent credential never leaves the server; the client only ever
// holds a token that expires quickly.
//
// Unlike Inworld, ElevenLabs' response carries no expiry: tokens last 15
// minutes and are consumed on first use, so expiresAt is synthesized here
// rather than read from the response.

// This module must never reach a client bundle — it reads the API secret.
// It is imported only by the server route handler (app/api/elevenlabs-token).

const TOKEN_URL =
  "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe";
const TOKEN_TTL_MS = 15 * 60 * 1000;

export interface ElevenLabsToken {
  /** The ElevenLabs-issued single-use realtime token. */
  token: string;
  /** Epoch-ms instant the token expires, synthesized (ElevenLabs returns no expiry). */
  expiresAt: number;
}

interface SingleUseTokenResponse {
  token: string;
}

/** Thrown when ElevenLabs credentials are absent on the server. */
export class ElevenLabsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElevenLabsConfigError";
  }
}

/** Thrown when ElevenLabs' token endpoint rejects the request. */
export class ElevenLabsTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElevenLabsTokenError";
  }
}

/**
 * Mints a short-lived, single-use ElevenLabs Scribe v2 Realtime token.
 * Throws ElevenLabsConfigError (missing creds) or ElevenLabsTokenError
 * (upstream rejection) — callers should map both to an opaque client error.
 */
export async function mintElevenLabsToken(): Promise<ElevenLabsToken> {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) {
    throw new ElevenLabsConfigError(
      "Missing ElevenLabs credentials: set ELEVENLABS_API_KEY"
    );
  }

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
      },
    });
  } catch (err) {
    throw new ElevenLabsTokenError(
      `Failed to reach ElevenLabs token endpoint: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  if (!response.ok) {
    // Read the body for server-side logging, but never surface it to callers.
    const detail = await response.text().catch(() => "");
    if (process.env.DEBUG_ELEVENLABS === "1") {
      console.error(
        `[elevenlabs-auth] Token endpoint returned ${response.status}${
          detail ? `: ${detail}` : ""
        }`
      );
    }
    throw new ElevenLabsTokenError(
      `ElevenLabs token endpoint returned ${response.status}`
    );
  }

  const data = (await response.json()) as SingleUseTokenResponse;
  if (!data.token) {
    throw new ElevenLabsTokenError("ElevenLabs token response missing token");
  }

  return {
    token: data.token,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  };
}

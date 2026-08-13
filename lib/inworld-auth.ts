// lib/inworld-auth.ts
//
// Server-only. Mints a short-lived Inworld session token (a Bearer JWT that
// Inworld itself signs) which the browser can then present on the STT
// WebSocket. This mirrors the AssemblyAI pattern in app/api/token/route.ts:
// the permanent credential never leaves the server; the client only ever
// holds a token that expires quickly.
//
// Why we don't sign the JWT ourselves: the STT endpoint rejects any token we
// sign with the shared secret (a self-signed HS256 JWT comes back as
// "signing method HS256 is invalid" / SESSION_TOKEN_INVALID). The endpoint
// wants an Inworld-*issued* token. So the "signing" here is really an
// authenticated exchange: we sign a per-request IW1-HMAC-SHA256 header with
// our secret, hand it to Inworld's token endpoint, and Inworld returns the
// asymmetrically-signed session token. Scheme reproduced from Inworld's
// official Node JWT sample app (inworld-ai/inworld-nodejs-jwt-sample-app).

import { createHmac, randomBytes } from "crypto";

// This module must never reach a client bundle — it reads the API secret.
// It is imported only by the server route handler (app/api/inworld-token),
// and uses Node's `crypto`, which would fail to bundle for the client anyway.

const TOKEN_HOST = process.env.INWORLD_HOST || "api.inworld.ai";
// The signature is computed against the *engine* host, not the API host, and
// against the GenerateToken RPC path — both are part of Inworld's canonical
// signing string, independent of the URL we actually POST to.
const ENGINE_HOST = process.env.INWORLD_ENGINE_HOST || "api-engine.inworld.ai";
const GENERATE_TOKEN_METHOD = "ai.inworld.engine.WorldEngine/GenerateToken";

export interface InworldToken {
  /** The Inworld-issued Bearer session token (a JWT). */
  token: string;
  /** ISO-8601 instant the token expires, straight from Inworld. */
  expiresAt: string;
  /** Optional session id Inworld returns alongside the token. */
  sessionId?: string;
}

interface GenerateTokenResponse {
  token: string;
  expirationTime: string;
  type: string;
  sessionId?: string;
}

interface KeyPair {
  key: string;
  secret: string;
}

/**
 * Resolves the Inworld key/secret pair. Prefers INWORLD_API_KEY — the single
 * Base64 "<key>:<secret>" credential from the Studio API Keys panel — and
 * falls back to a split INWORLD_KEY / INWORLD_SECRET pair.
 */
function resolveKeyPair(): KeyPair | null {
  const basic = process.env.INWORLD_API_KEY?.trim();
  if (basic) {
    const decoded = Buffer.from(basic, "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx > 0) {
      const key = decoded.slice(0, idx);
      const secret = decoded.slice(idx + 1);
      if (key && secret) {
        return { key, secret };
      }
    }
    return null;
  }
  const key = process.env.INWORLD_KEY?.trim();
  const secret = process.env.INWORLD_SECRET?.trim();
  if (key && secret) {
    return { key, secret };
  }
  return null;
}

/** Current UTC time as `YYYYMMDDHHMMSS`, the format Inworld's signer expects. */
function getDateTime(): string {
  const [date, time] = new Date().toISOString().split("T");
  return `${date.replace(/-/g, "")}${time.replace(/:/g, "").substring(0, 6)}`;
}

/**
 * Reproduces Inworld's IW1 signature chain (their sample app does this with
 * crypto-js; this is the byte-identical Node `crypto` equivalent). Each HMAC's
 * raw digest becomes the key for the next; the seed key is the literal string
 * `IW1<secret>`, and the chain is sealed with a final `iw1_request` HMAC.
 */
function computeSignature(secret: string, params: string[]): string {
  let key: string | Buffer = `IW1${secret}`;
  for (const part of params) {
    key = createHmac("sha256", key).update(part, "utf8").digest();
  }
  return createHmac("sha256", key).update("iw1_request", "utf8").digest("hex");
}

function buildAuthorizationHeader(pair: KeyPair): string {
  const datetime = getDateTime();
  // 11-char hex nonce, matching the sample app's randomBytes(16).hex.slice(1,12).
  const nonce = randomBytes(16).toString("hex").slice(1, 12);
  const signature = computeSignature(pair.secret, [
    datetime,
    ENGINE_HOST.replace(":443", ""),
    GENERATE_TOKEN_METHOD,
    nonce,
  ]);
  return `IW1-HMAC-SHA256 ApiKey=${pair.key},DateTime=${datetime},Nonce=${nonce},Signature=${signature}`;
}

/** Thrown when Inworld credentials are absent or malformed on the server. */
export class InworldConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InworldConfigError";
  }
}

/** Thrown when Inworld's token endpoint rejects the request. */
export class InworldTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InworldTokenError";
  }
}

/**
 * Mints a short-lived Inworld session token by making the signed GenerateToken
 * exchange. `resources` scopes the token; an empty list (the default) lets
 * Inworld infer scope from the key, which is what the working STT/Voice key
 * uses. Throws InworldConfigError (missing creds) or InworldTokenError
 * (upstream rejection) — callers should map both to an opaque client error.
 */
export async function mintInworldToken(
  resources: string[] = []
): Promise<InworldToken> {
  const pair = resolveKeyPair();
  if (!pair) {
    throw new InworldConfigError(
      "Missing/invalid Inworld credentials: set INWORLD_API_KEY (base64 of \"<key>:<secret>\")"
    );
  }

  let response: Response;
  try {
    response = await fetch(
      `https://${TOKEN_HOST}/auth/v1/tokens/token:generate`,
      {
        method: "POST",
        headers: {
          Authorization: buildAuthorizationHeader(pair),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ key: pair.key, resources }),
      }
    );
  } catch (err) {
    throw new InworldTokenError(
      `Failed to reach Inworld token endpoint: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  if (!response.ok) {
    // Read the body for server-side logging, but never surface it to callers.
    const detail = await response.text().catch(() => "");
    throw new InworldTokenError(
      `Inworld token endpoint returned ${response.status}${
        detail ? `: ${detail}` : ""
      }`
    );
  }

  const data = (await response.json()) as GenerateTokenResponse;
  if (!data.token || !data.expirationTime) {
    throw new InworldTokenError("Inworld token response missing token/expiry");
  }

  return {
    token: data.token,
    expiresAt: data.expirationTime,
    sessionId: data.sessionId,
  };
}

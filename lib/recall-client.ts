// Server-only. Talks to the Recall.ai v1.11 API. This module reads
// RECALL_API_KEY and must never be imported into a client component — the key
// would leak to the browser. It only imports node:fs / node:path, so a client
// bundle attempting to include it would fail to build, which is the guard.
//
// Region + API version: the base URL is https://<RECALL_REGION>.recall.ai and
// every path is under /api/v1 (the account is pinned to the v1.11 API).
// The Authorization header is the RAW api key — no "Bearer" prefix.
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Bytes of a base64 payload Recall accepts for a single media output. */
const MEDIA_B64_MAX_BYTES = 1_835_008;

/**
 * A non-2xx response from the Recall API, carrying the upstream status and raw
 * body so callers can surface the full error (Recall's 400s explain exactly
 * which field it rejected — invaluable when debugging in production).
 */
export class RecallApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    operation: string
  ) {
    super(`Recall ${operation} failed (${status}): ${body}`);
    this.name = "RecallApiError";
  }
}

function recallBaseUrl(): string {
  const region = process.env.RECALL_REGION;
  if (!region) {
    throw new Error("RECALL_REGION is not set");
  }
  return `https://${region}.recall.ai`;
}

function recallApiKey(): string {
  const key = process.env.RECALL_API_KEY;
  if (!key) {
    throw new Error("RECALL_API_KEY is not set");
  }
  return key;
}

function publicBaseUrl(): string {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) {
    throw new Error("PUBLIC_BASE_URL is not set");
  }
  return base.replace(/\/+$/, "");
}

// The bot's camera image and intro audio, base64-encoded. Read once per warm
// instance and cached — the files are shipped into this route's serverless
// bundle via outputFileTracingIncludes in next.config.ts.
let mediaCache: { logoB64: string; introB64: string } | null = null;

async function loadMedia(): Promise<{ logoB64: string; introB64: string }> {
  if (mediaCache) {
    return mediaCache;
  }
  const dir = path.join(process.cwd(), "assets", "notetaker");
  const [logo, intro] = await Promise.all([
    readFile(path.join(dir, "logo.jpg")),
    readFile(path.join(dir, "intro.mp3")),
  ]);
  const logoB64 = logo.toString("base64");
  const introB64 = intro.toString("base64");
  for (const [name, b64] of [
    ["logo.jpg", logoB64],
    ["intro.mp3", introB64],
  ] as const) {
    if (b64.length > MEDIA_B64_MAX_BYTES) {
      throw new Error(
        `${name} is too large for Recall media output (${b64.length} > ${MEDIA_B64_MAX_BYTES} base64 bytes)`
      );
    }
  }
  mediaCache = { logoB64, introB64 };
  return mediaCache;
}

/**
 * Builds the exact Create Bot request body. Kept separate so it can be reviewed
 * (and unit-tested) independently of the network call. Every field name here is
 * verified against the live v1.11 Create Bot reference.
 */
export async function buildCreateBotBody(meetingUrl: string) {
  const { logoB64, introB64 } = await loadMedia();
  // TODO: On Google Meet the bot joins as an anonymous guest, so a human has to
  // manually admit it every time. Recall's signed-in-bot flow (authenticating
  // the bot against a Google account) would let it join as a signed-in user and
  // remove that manual-admission requirement. Not wired up — the bot is
  // anonymous on every platform today.
  return {
    meeting_url: meetingUrl,
    bot_name: "Kluely Notetaker",
    recording_config: {
      // Recall.ai's own streaming transcription.
      transcript: {
        provider: {
          recallai_streaming: {
            mode: "prioritize_low_latency",
            language_code: "en",
          },
        },
      },
      // Real-time transcript utterances are POSTed to our webhook. Bot
      // status-change events are NOT delivered here in v1.11 — they come via the
      // account-level webhook configured in the Recall dashboard (see webhook route).
      realtime_endpoints: [
        {
          type: "webhook",
          url: `${publicBaseUrl()}/api/recall/webhook`,
          events: ["transcript.data"],
        },
      ],
    },
    // The bot shows the Kluely logo as its camera feed. Mutually exclusive with
    // output_media, so we use the automatic_* pair only.
    //
    // NOTE the real asymmetry, confirmed against a live 400: video output puts
    // kind/b64_data DIRECTLY on in_call_recording / in_call_not_recording (no
    // "data" wrapper), whereas audio output nests them under "data" (below).
    automatic_video_output: {
      in_call_recording: { kind: "jpeg", b64_data: logoB64 },
      in_call_not_recording: { kind: "jpeg", b64_data: logoB64 },
    },
    // The bot plays a short intro clip once it's in the call. Audio DOES use the
    // "data" wrapper (unlike video above).
    automatic_audio_output: {
      in_call_recording: { data: { kind: "mp3", b64_data: introB64 } },
    },
    // Let the bot leave on its own so it never lingers in an empty/abandoned call.
    // waiting_room_timeout is short (300s) so we fail fast and clearly if nobody
    // admits the bot, rather than leaving it stuck in the waiting room.
    automatic_leave: {
      waiting_room_timeout: 300,
      noone_joined_timeout: 1200,
      everyone_left_timeout: { timeout: 60 },
    },
  };
}

export interface CreateBotResult {
  botId: string;
}

/** Creates a Recall bot for a meeting and returns its id. */
export async function createBot(meetingUrl: string): Promise<CreateBotResult> {
  const body = await buildCreateBotBody(meetingUrl);
  const res = await fetch(`${recallBaseUrl()}/api/v1/bot/`, {
    method: "POST",
    headers: {
      Authorization: recallApiKey(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new RecallApiError(res.status, await res.text(), "createBot");
  }

  const data = (await res.json()) as { id?: string };
  if (!data.id) {
    throw new Error("Recall createBot response had no bot id");
  }
  return { botId: data.id };
}

/** Asks a bot to leave its call. No request body per the v1.11 reference. */
export async function leaveCall(botId: string): Promise<void> {
  const res = await fetch(
    `${recallBaseUrl()}/api/v1/bot/${encodeURIComponent(botId)}/leave_call/`,
    {
      method: "POST",
      headers: { Authorization: recallApiKey() },
    }
  );
  // Treat "already gone" as success — the client's goal is that the bot leaves.
  if (!res.ok && res.status !== 400 && res.status !== 404) {
    throw new RecallApiError(res.status, await res.text(), "leaveCall");
  }
}

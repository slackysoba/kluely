// Server-only. Notetaker session state, persisted in Redis and keyed by the
// Recall bot id. Serverless functions share no memory, so every request reads
// and writes here rather than any in-process Map.
//
// Data model per bot:
//   notetaker:<botId>        HASH  { status, meetingUrl, createdAt, updatedAt }
//   notetaker:<botId>:lines  LIST  JSON-encoded TranscriptLine, appended in order
//
// Both keys carry a TTL so transcripts don't linger forever — this is a demo
// with no auth (see the SECURITY note in the webhook/session routes).
import { getRedis } from "@/lib/redis";

// Sessions (and their transcripts) expire this long after the last write.
const SESSION_TTL_SECONDS = 60 * 60 * 24; // 24 hours

export interface TranscriptLine {
  /** Participant name from Recall, or null when it isn't reported. */
  speaker: string | null;
  text: string;
  /** ISO timestamp of when this line was appended. */
  at: string;
}

export interface NotetakerSession {
  botId: string;
  /** Latest Recall bot status code, e.g. "in_waiting_room", "in_call_recording". */
  status: string;
  meetingUrl: string;
  createdAt: string;
  updatedAt: string;
  lines: TranscriptLine[];
}

function hashKey(botId: string): string {
  return `notetaker:${botId}`;
}

function linesKey(botId: string): string {
  return `notetaker:${botId}:lines`;
}

/** Records a freshly-created bot so the session GET has something to return. */
export async function createSession(
  botId: string,
  meetingUrl: string
): Promise<void> {
  const redis = getRedis();
  const now = new Date().toISOString();
  await redis
    .multi()
    .hset(hashKey(botId), {
      status: "created",
      meetingUrl,
      createdAt: now,
      updatedAt: now,
    })
    .expire(hashKey(botId), SESSION_TTL_SECONDS)
    .exec();
}

/** Updates the bot's status (from a status-change webhook). */
export async function setStatus(botId: string, status: string): Promise<void> {
  const redis = getRedis();
  const now = new Date().toISOString();
  await redis
    .multi()
    .hset(hashKey(botId), { status, updatedAt: now })
    .expire(hashKey(botId), SESSION_TTL_SECONDS)
    .exec();
}

/** Appends one finalized transcript line (from a transcript.data webhook). */
export async function appendLine(
  botId: string,
  line: TranscriptLine
): Promise<void> {
  const redis = getRedis();
  const now = new Date().toISOString();
  await redis
    .multi()
    .rpush(linesKey(botId), JSON.stringify(line))
    .expire(linesKey(botId), SESSION_TTL_SECONDS)
    .hset(hashKey(botId), { updatedAt: now })
    .expire(hashKey(botId), SESSION_TTL_SECONDS)
    .exec();
}

/**
 * Returns the full session for a botId, or null if it was never created (or has
 * expired). The caller must already know the botId — there is deliberately no
 * "list all sessions" query, which would leak transcripts between visitors.
 */
export async function getSession(
  botId: string
): Promise<NotetakerSession | null> {
  const redis = getRedis();
  const [hash, rawLines] = await Promise.all([
    redis.hgetall(hashKey(botId)),
    redis.lrange(linesKey(botId), 0, -1),
  ]);

  if (!hash || Object.keys(hash).length === 0) {
    return null;
  }

  const lines: TranscriptLine[] = rawLines
    .map((raw) => {
      try {
        return JSON.parse(raw) as TranscriptLine;
      } catch {
        return null;
      }
    })
    .filter((line): line is TranscriptLine => line !== null);

  return {
    botId,
    status: hash.status ?? "unknown",
    meetingUrl: hash.meetingUrl ?? "",
    createdAt: hash.createdAt ?? "",
    updatedAt: hash.updatedAt ?? "",
    lines,
  };
}

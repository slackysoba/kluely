// Recall.ai webhook sink. Receives two kinds of events at this one URL:
//
//   1. transcript.data  — real-time utterances, from the per-bot
//      recording_config.realtime_endpoints we set in Create Bot.
//   2. bot.<status>      — status-change events (bot.in_waiting_room,
//      bot.in_call_recording, bot.done, ...). In v1.11 these are NOT delivered
//      via realtime_endpoints; they come from the ACCOUNT-LEVEL webhook you
//      configure in the Recall dashboard. Point that dashboard webhook at this
//      same URL so both shapes land here.
//
// Must return 2xx within Recall's 15s webhook timeout, so we do the minimum
// (append/set in Redis) and always ack — a 5xx would trigger retries.
//
// SECURITY / TODO: this endpoint does not verify the webhook signature. The
// real fix is Svix signature verification (svix-id / svix-timestamp /
// svix-signature headers) using the endpoint's signing secret before trusting
// any payload.
import type { NextRequest } from "next/server";
import { appendLine, setStatus } from "@/lib/notetaker-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RecallWebhookPayload {
  event?: string;
  data?: {
    data?: {
      // transcript.data
      words?: Array<{ text?: string }>;
      participant?: { name?: string | null };
      // status-change
      code?: string;
    };
    bot?: { id?: string };
  };
}

export async function POST(request: NextRequest) {
  // Read the body as text first so we can log it raw even if JSON parsing fails
  // — Vercel logs are the only production debugging window (set DEBUG_RECALL=1).
  const raw = await request.text();
  const debug = process.env.DEBUG_RECALL === "1";

  let payload: RecallWebhookPayload;
  try {
    payload = JSON.parse(raw) as RecallWebhookPayload;
  } catch {
    if (debug) {
      console.log("[recall webhook] unparseable payload:", raw);
    }
    // Poison body — ack so Recall doesn't retry it forever.
    return new Response("ok", { status: 200 });
  }

  try {
    const event = payload.event ?? "";
    if (debug) {
      // Full raw payload for both transcript.data and status-change events.
      console.log(`[recall webhook] event=${event} raw=${raw}`);
    }
    // Both event shapes nest the bot id at data.bot.id.
    const botId = payload.data?.bot?.id;
    if (!botId) {
      return new Response("ok", { status: 200 });
    }

    if (event === "transcript.data") {
      const words = payload.data?.data?.words ?? [];
      const text = words
        .map((w) => w.text ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) {
        const speaker = payload.data?.data?.participant?.name ?? null;
        await appendLine(botId, {
          speaker,
          text,
          at: new Date().toISOString(),
        });
      }
    } else if (event.startsWith("bot.")) {
      // Prefer the explicit status code; fall back to the event suffix.
      const code = payload.data?.data?.code ?? event.slice("bot.".length);
      await setStatus(botId, code);
    }
  } catch (err) {
    // Log but still ack: the webhook must return 2xx quickly, and dropping one
    // utterance beats a retry storm.
    console.error("[recall webhook]", err);
  }

  return new Response("ok", { status: 200 });
}

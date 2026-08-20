// POST { meetingUrl } -> { botId }
// Validates the meeting URL (Zoom or Google Meet), sends a Recall bot into the
// call, and records the session in Redis so the client can poll it back by
// botId. Recall drives both platforms with the same Create Bot API, so the only
// platform-specific logic here is URL detection.
//
// SECURITY / TODO: There is no auth. Anyone who can reach this endpoint can
// spin up a bot against any meeting URL. The real fix is to require an
// authenticated user and rate-limit per account before creating bots.
import type { NextRequest } from "next/server";
import { createBot, RecallApiError } from "@/lib/recall-client";
import { createSession, type NotetakerPlatform } from "@/lib/notetaker-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Detects the conferencing platform from a join URL, or null if it's neither a
 * recognized Zoom nor Google Meet link. Recall handles both identically once
 * the bot is created — this only decides validity and what we label the session.
 */
function detectPlatform(raw: string): NotetakerPlatform | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") {
    return null;
  }
  const host = url.hostname.toLowerCase();

  // Zoom join links carry a meeting path: /j/<id>, /w/<id>, /wc/<id>/join,
  // /s/<id>, /my/<name>.
  if (
    (host === "zoom.us" || host.endsWith(".zoom.us")) &&
    /\/(j|w|wc|s|my)\//.test(url.pathname)
  ) {
    return "zoom";
  }

  // Google Meet links are meet.google.com/<xxx-xxxx-xxx> meeting codes.
  if (
    host === "meet.google.com" &&
    /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}(\/|$)/i.test(url.pathname)
  ) {
    return "google_meet";
  }

  return null;
}

export async function POST(request: NextRequest) {
  let meetingUrl: unknown;
  try {
    const body = await request.json();
    meetingUrl = (body as { meetingUrl?: unknown })?.meetingUrl;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const platform =
    typeof meetingUrl === "string" ? detectPlatform(meetingUrl) : null;
  if (typeof meetingUrl !== "string" || platform === null) {
    return Response.json(
      { error: "A valid Zoom or Google Meet URL is required" },
      { status: 400 }
    );
  }

  try {
    const { botId } = await createBot(meetingUrl);
    await createSession(botId, meetingUrl, platform);
    return Response.json({ botId });
  } catch (err) {
    // Surface Recall's full error body verbatim rather than swallowing it — its
    // 400s name the exact field it rejected (e.g. automatic_video_output shape),
    // which is the fastest way to debug a failed first bot creation.
    if (err instanceof RecallApiError) {
      console.error(`[create-bot] Recall ${err.status}:`, err.body);
      return Response.json(
        { error: "Recall rejected the request", recallStatus: err.status, recallBody: err.body },
        { status: 502 }
      );
    }
    console.error("[create-bot]", err);
    return Response.json({ error: "Failed to create bot" }, { status: 502 });
  }
}

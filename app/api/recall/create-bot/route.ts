// POST { meetingUrl } -> { botId }
// Validates the Zoom URL, sends a Recall bot into the call, and records the
// session in Redis so the client can poll it back by botId.
//
// SECURITY / TODO: There is no auth. Anyone who can reach this endpoint can
// spin up a bot against any Zoom URL. The real fix is to require an
// authenticated user and rate-limit per account before creating bots.
import type { NextRequest } from "next/server";
import { createBot, RecallApiError } from "@/lib/recall-client";
import { createSession } from "@/lib/notetaker-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Accepts Zoom join links across the various host/path shapes Zoom emits. */
function isZoomUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") {
      return false;
    }
    const host = url.hostname.toLowerCase();
    if (host !== "zoom.us" && !host.endsWith(".zoom.us")) {
      return false;
    }
    // Join links carry a meeting path: /j/<id>, /w/<id>, /wc/<id>/join,
    // /s/<id>, /my/<name>.
    return /\/(j|w|wc|s|my)\//.test(url.pathname);
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  let meetingUrl: unknown;
  try {
    const body = await request.json();
    meetingUrl = (body as { meetingUrl?: unknown })?.meetingUrl;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof meetingUrl !== "string" || !isZoomUrl(meetingUrl)) {
    return Response.json(
      { error: "A valid Zoom meeting URL is required" },
      { status: 400 }
    );
  }

  try {
    const { botId } = await createBot(meetingUrl);
    await createSession(botId, meetingUrl);
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

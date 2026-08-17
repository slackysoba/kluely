// GET /api/recall/session/<botId> -> { botId, status, meetingUrl, lines, ... }
// The client polls this every 2s. It only ever returns the session for the
// botId in the path.
//
// SECURITY / TODO: There is deliberately NO endpoint that lists sessions — that
// would leak one visitor's transcript to another. Access is by unguessable
// botId only, which is obscurity, not security. The real fix is auth: bind each
// session to an authenticated user and check ownership here.
import type { NextRequest } from "next/server";
import { getSession } from "@/lib/notetaker-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ botId: string }> }
) {
  const { botId } = await params;
  if (!botId) {
    return Response.json({ error: "botId is required" }, { status: 400 });
  }

  const session = await getSession(botId);
  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  return Response.json(session);
}

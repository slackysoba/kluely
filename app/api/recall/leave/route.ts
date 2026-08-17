// POST { botId } -> asks the Recall bot to leave the call.
import type { NextRequest } from "next/server";
import { leaveCall } from "@/lib/recall-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let botId: unknown;
  try {
    const body = await request.json();
    botId = (body as { botId?: unknown })?.botId;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof botId !== "string" || !botId) {
    return Response.json({ error: "botId is required" }, { status: 400 });
  }

  try {
    await leaveCall(botId);
    return Response.json({ ok: true });
  } catch (err) {
    console.error("[leave]", err);
    return Response.json({ error: "Failed to leave call" }, { status: 502 });
  }
}

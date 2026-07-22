// app/api/verify/route.ts
//
// Morphology confidence for an already-generated Klingon rendering. Split out
// from /api/answer so it runs off the visible answer's critical path: the app
// shows the Klingon immediately, then calls this to resolve the confidence
// marker. Delegates the actual analysis to the yajwiz validator function
// (api/validate-klingon.py) via lib/klingon-validate.

import { NextResponse } from "next/server";
import { computeConfidence } from "@/lib/klingon-validate";
import {
  KeyedSlidingWindow,
  SlidingWindow,
  clientIp,
} from "@/lib/rate-limit";

const TIMEOUT_MS = 10_000;
const MAX_TEXT_LENGTH = 2_000;

// Verification is cheaper and more forgiving than generation, but still fans
// out to the Python function, so keep a light cap.
const perIpLimiter = new KeyedSlidingWindow(30);
const globalLimiter = new SlidingWindow(30);

/** Best deployment origin for the internal call to the validator function. */
function selfOrigin(request: Request): string | null {
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  try {
    return new URL(request.url).origin;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  if (!perIpLimiter.tryHit(clientIp(request)) || !globalLimiter.tryHit()) {
    // Rate-limited verification just leaves the answer unverified.
    return NextResponse.json({ confidence: "low" }, { status: 429 });
  }

  let klingon: string;
  let english: string;
  try {
    const body = (await request.json()) as {
      klingon?: unknown;
      english?: unknown;
    };
    if (
      typeof body.klingon !== "string" ||
      body.klingon.trim().length === 0 ||
      body.klingon.length > MAX_TEXT_LENGTH
    ) {
      throw new Error("invalid");
    }
    klingon = body.klingon.trim();
    english = typeof body.english === "string" ? body.english : "";
  } catch {
    return NextResponse.json(
      { error: "Request body must be JSON: { klingon: string, english?: string }" },
      { status: 400 }
    );
  }

  const origin = selfOrigin(request);
  if (!origin) {
    return NextResponse.json({ confidence: "low" });
  }

  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const confidence = await computeConfidence(klingon, english, origin, signal);
    return NextResponse.json({ confidence });
  } catch {
    // Any failure (including timeout) means we couldn't verify → low confidence.
    return NextResponse.json({ confidence: "low" });
  }
}

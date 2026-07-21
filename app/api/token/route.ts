// app/api/token/route.ts
//
// Generates a short-lived AssemblyAI streaming token for the browser.
// The permanent API key must never be shipped to the client — anyone could
// extract it and run transcription on our account. Instead, the server
// exchanges the key for a single-use temporary token that expires quickly,
// so the worst-case leak is one short streaming session.

import { NextResponse } from "next/server";

// Never cache this route — every client needs a fresh, single-use token.
export const dynamic = "force-dynamic";

export async function GET() {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;

  // Fail generically: never echo the key or upstream error text to the client.
  if (!apiKey) {
    return NextResponse.json(
      { error: "Failed to generate token" },
      { status: 500 }
    );
  }

  const url = new URL("https://streaming.assemblyai.com/v3/token");
  // Token redemption window: client has 60s to open the WebSocket.
  url.searchParams.set("expires_in_seconds", "60");
  // Cap the resulting streaming session at 10 minutes.
  url.searchParams.set("max_session_duration_seconds", "600");

  try {
    const response = await fetch(url, {
      headers: { Authorization: apiKey },
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: "Failed to generate token" },
        { status: 500 }
      );
    }

    const { token } = (await response.json()) as { token: string };
    return NextResponse.json({ token });
  } catch {
    return NextResponse.json(
      { error: "Failed to generate token" },
      { status: 500 }
    );
  }
}

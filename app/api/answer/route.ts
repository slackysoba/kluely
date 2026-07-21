// app/api/answer/route.ts
//
// Turns an interview question into a strong English answer plus its Klingon
// rendering, via Gemini structured output. The English answer is the primary
// product; the Klingon fields are derived from it per the grammar primer.

import { NextResponse } from "next/server";
import { KLINGON_GRAMMAR_PRIMER } from "@/lib/klingon-grammar";

// Fastest Flash-family model. Swap here if a newer one ships.
const MODEL = "gemini-3.5-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// One overall budget shared by both attempts, not 10s per attempt.
const TIMEOUT_MS = 10_000;
const MAX_QUESTION_LENGTH = 2_000;

interface AnswerPayload {
  english: string;
  klingon: string;
  pIqaD: string;
  backTranslation: string;
}

interface GeminiResponse {
  candidates?: {
    content?: {
      parts?: { text?: string }[];
    };
  }[];
}

const SYSTEM_INSTRUCTION = `You are an elite interview coach. The user gives you an interview question. Write the strongest possible answer for a candidate to give: specific, confident, and structured — no filler, no "great question", no hedging. Two to three sentences.

Then render that answer in Klingon according to the primer below.

${KLINGON_GRAMMAR_PRIMER}`;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    english: {
      type: "STRING",
      description:
        "A strong, concise interview answer. 2-3 sentences, specific and confident.",
    },
    klingon: {
      type: "STRING",
      description:
        "The answer in Klingon, Latin transcription, correct capitalization, OVS order.",
    },
    pIqaD: {
      type: "STRING",
      description: "The Klingon text transliterated into pIqaD script.",
    },
    backTranslation: {
      type: "STRING",
      description:
        "A literal, structure-revealing English back-translation of the Klingon.",
    },
  },
  required: ["english", "klingon", "pIqaD", "backTranslation"],
  propertyOrdering: ["english", "klingon", "pIqaD", "backTranslation"],
} as const;

function parseAnswer(text: string): AnswerPayload | null {
  try {
    const data: unknown = JSON.parse(text);
    if (typeof data !== "object" || data === null) {
      return null;
    }
    const record = data as Record<string, unknown>;
    const { english, klingon, pIqaD, backTranslation } = record;
    if (
      typeof english === "string" &&
      english.length > 0 &&
      typeof klingon === "string" &&
      klingon.length > 0 &&
      typeof pIqaD === "string" &&
      pIqaD.length > 0 &&
      typeof backTranslation === "string" &&
      backTranslation.length > 0
    ) {
      return { english, klingon, pIqaD, backTranslation };
    }
  } catch {
    // Malformed JSON from the model; caller decides whether to retry.
  }
  return null;
}

async function generateAnswer(
  question: string,
  apiKey: string,
  signal: AbortSignal
): Promise<AnswerPayload | null> {
  const upstream = await fetch(GEMINI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      contents: [{ role: "user", parts: [{ text: question }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    }),
    signal,
  });

  if (!upstream.ok) {
    // Log status only — upstream error bodies must never reach the client,
    // and we don't want key-bearing URLs or headers in logs either.
    console.error(`Gemini request failed with status ${upstream.status}`);
    return null;
  }

  const data = (await upstream.json()) as GeminiResponse;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") {
    return null;
  }
  return parseAnswer(text);
}

export async function POST(request: Request) {
  let question: string;
  try {
    const body = (await request.json()) as { question?: unknown };
    if (
      typeof body.question !== "string" ||
      body.question.trim().length === 0 ||
      body.question.length > MAX_QUESTION_LENGTH
    ) {
      throw new Error("invalid");
    }
    question = body.question.trim();
  } catch {
    return NextResponse.json(
      { error: "Request body must be JSON: { question: string }" },
      { status: 400 }
    );
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not set");
    return NextResponse.json(
      { error: "Failed to generate answer" },
      { status: 500 }
    );
  }

  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    // Retry once if the model returns malformed or incomplete JSON.
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = await generateAnswer(question, apiKey, signal);
      if (answer) {
        return NextResponse.json(answer);
      }
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return NextResponse.json(
        { error: "Answer generation timed out" },
        { status: 504 }
      );
    }
    // Never forward upstream error details to the client.
    console.error("Answer generation failed:", err);
  }

  return NextResponse.json(
    { error: "Failed to generate answer" },
    { status: 502 }
  );
}

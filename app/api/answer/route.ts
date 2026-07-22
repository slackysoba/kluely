// app/api/answer/route.ts
//
// Turns an interview question into a strong English answer plus its Klingon
// rendering. The Klingon is *grounded*: rather than trusting the model's
// memory of Klingon vocabulary, we
//   1. generate the English answer and extract its key concepts,
//   2. look those concepts up in the canonical boQwI' lexicon
//      (data/klingon-lexicon.json) to get verified, attested Klingon roots,
//   3. hand ONLY those verified words (with glosses) to a second model call
//      that assembles them with correct morphology and OVS order.
// The model may paraphrase with the supplied words but must never invent one.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { KLINGON_GRAMMAR_PRIMER } from "@/lib/klingon-grammar";
import { toPiqad } from "@/lib/piqad";
import {
  KeyedSlidingWindow,
  SlidingWindow,
  clientIp,
} from "@/lib/rate-limit";

// Fastest Flash-family model. Swap here if a newer one ships.
const MODEL = "gemini-3.5-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// One overall budget shared by the two grounded model calls. Morphology
// validation runs separately (app/api/verify), off the visible answer's
// critical path, so it doesn't count against this.
const TIMEOUT_MS = 12_000;
const MAX_QUESTION_LENGTH = 2_000;

// Grounding knobs: cap how many verified roots each concept contributes and how
// many reach the prompt overall, so the vocabulary list stays tight.
const MAX_SENSES_PER_CONCEPT = 4;
const MAX_VOCABULARY = 50;

// Demo abuse protection. The global cap stays under the Gemini free tier's
// 15 RPM. Note each request now makes up to two grounded calls (plus a
// possible legacy fallback), so this bounds *requests*, not upstream calls.
const perIpLimiter = new KeyedSlidingWindow(10);
const globalLimiter = new SlidingWindow(12);

// ---------------------------------------------------------------------------
// Lexicon (loaded once per instance)
// ---------------------------------------------------------------------------

interface LexiconSense {
  klingon: string;
  pos: string;
  tags: string[];
  gloss: string;
  canon: boolean;
  homophone: string | null;
}

interface Lexicon {
  englishToKlingon: Record<string, LexiconSense[]>;
}

// Read from disk (traced into the bundle via next.config outputFileTracingIncludes)
// rather than `import`ing the 4MB JSON, which would balloon tsc's inferred types.
const lexicon: Lexicon = (() => {
  try {
    const raw = readFileSync(
      join(process.cwd(), "data", "klingon-lexicon.json"),
      "utf8"
    );
    return JSON.parse(raw) as Lexicon;
  } catch (err) {
    console.error("Failed to load Klingon lexicon:", err);
    return { englishToKlingon: {} };
  }
})();

// Generic interview roots always offered to the Klingon step as a fallback
// baseline, so it has verified material even when few answer concepts hit the
// lexicon. All still come from the verified lexicon — nothing invented.
const SEED_CONCEPTS = [
  "succeed",
  "work",
  "learn",
  "know",
  "lead",
  "group",
  "goal",
  "task",
  "try",
  "help",
  "create",
  "improve",
  "good",
  "strong",
  "do",
];

// Confidence is no longer part of generation: the client requests it
// separately from /api/verify once the answer is on screen.
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

// ---------------------------------------------------------------------------
// Prompts and schemas
// ---------------------------------------------------------------------------

const SYSTEM_ENGLISH = `You are an elite interview coach. The user gives you an interview question. Do two things:

1. Write the strongest possible answer for a candidate to give: specific, confident, and structured — no filler, no "great question", no hedging. Two to three sentences. This English answer is the primary product.

2. Extract the key content words and concepts your answer expresses, as simple English dictionary-lookup terms (they will be looked up in a Klingon dictionary). Rules for the "concepts" list:
   - Use base/lemma forms: verbs uninflected ("lead", not "led" or "leading"); nouns singular ("goal", not "goals"); qualities as plain adjectives ("brave").
   - Prefer common, concrete words over abstract or idiomatic ones.
   - For any idiom, jargon, or rare term, ALSO include a plain-language synonym or the underlying concept — e.g. for "optimize" add "improve" and "make better"; for "leverage" add "use"; for "pipeline" add "process" and "system"; for "stakeholder" add "leader" and "person"; for "team" add "group".
   - 8 to 16 concepts, ordered by importance.

Return strict JSON: { "english": ..., "concepts": [...] }.`;

const SCHEMA_ENGLISH = {
  type: "OBJECT",
  properties: {
    english: {
      type: "STRING",
      description:
        "A strong, concise interview answer. 2-3 sentences, specific and confident.",
    },
    concepts: {
      type: "ARRAY",
      description:
        "8-16 key content words/concepts from the answer, as simple English lemmas for dictionary lookup, including plain-language synonyms for idioms/jargon.",
      items: { type: "STRING" },
    },
  },
  required: ["english", "concepts"],
  propertyOrdering: ["english", "concepts"],
} as const;

const SYSTEM_KLINGON = `${KLINGON_GRAMMAR_PRIMER}

---

# GROUNDING OVERRIDE — takes precedence over any vocabulary shown in the primer above

You are translating a fixed English answer into Klingon, grounded in a verified vocabulary list. Everything above is your GRAMMAR reference only — its example words are illustrations, not a vocabulary you may draw from.

The user message gives you:
  - VERIFIED VOCABULARY: canonical Klingon roots (from the boQwI' dictionary) with their exact glosses. These are the ONLY content roots you may use.
  - The ENGLISH ANSWER to render.

Hard rules:
1. Content roots (nouns, verbs, adjectival verbs, adverbs): use ONLY roots from the VERIFIED VOCABULARY list. Do NOT use any other content root — not ones from the primer's examples, not ones from your own memory. If a needed word is not in the list, PARAPHRASE the idea using words that ARE in the list. If you truly cannot express something, drop it rather than invent a word.
2. You MAY freely use the grammatical apparatus described in the primer: verb prefixes, verb suffixes, noun suffixes, the pronouns (jIH, SoH, ghaH, 'oH, maH, tlhIH, chaH), conjunctions ('ej, 'ach, vaj, pagh, qoj, 'e'), numbers, and the fixed set phrases (Qapla', majQa', nuqneH, lu'/luq).
3. Apply correct Klingon morphology (attach prefixes and suffixes per the primer) and strict OVS (Object–Verb–Subject) word order.
4. Translate the SUBSTANCE, not every word. Keep it short — a compressed, accurate rendering beats a long, padded one. Never invent vocabulary.

Return strict JSON with exactly two fields:
  - "klingon": the rendering in Latin transcription, correct capitalization, OVS order.
  - "backTranslation": a literal, structure-revealing English back-translation (deliberately awkward, revealing the Klingon structure).
Do NOT produce pIqaD; it is derived mechanically downstream.`;

const SCHEMA_KLINGON = {
  type: "OBJECT",
  properties: {
    klingon: {
      type: "STRING",
      description:
        "The answer in Klingon, Latin transcription, correct capitalization, OVS order, built only from the supplied vocabulary.",
    },
    backTranslation: {
      type: "STRING",
      description:
        "A literal, structure-revealing English back-translation of the Klingon.",
    },
  },
  required: ["klingon", "backTranslation"],
  propertyOrdering: ["klingon", "backTranslation"],
} as const;

// Legacy single-call path — used only if the grounded flow can't produce a
// valid result, so the demo degrades instead of hard-failing.
const SYSTEM_LEGACY = `You are an elite interview coach. The user gives you an interview question. Write the strongest possible answer for a candidate to give: specific, confident, and structured — no filler, no "great question", no hedging. Two to three sentences.

Then render that answer in Klingon according to the primer below.

One override to the primer's output requirements: do NOT produce the pIqaD field. Return only english, klingon, and backTranslation. The pIqaD transliteration is derived mechanically from your Latin transcription.

${KLINGON_GRAMMAR_PRIMER}`;

const SCHEMA_LEGACY = {
  type: "OBJECT",
  properties: {
    english: { type: "STRING" },
    klingon: { type: "STRING" },
    backTranslation: { type: "STRING" },
  },
  required: ["english", "klingon", "backTranslation"],
  propertyOrdering: ["english", "klingon", "backTranslation"],
} as const;

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

/** One structured-output call. Returns the parsed JSON object, or null. */
async function callGemini(
  systemInstruction: string,
  userText: string,
  responseSchema: object,
  apiKey: string,
  signal: AbortSignal
): Promise<Record<string, unknown> | null> {
  const upstream = await fetch(GEMINI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema,
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
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null; // Malformed JSON from the model; caller decides whether to retry.
  }
}

// ---------------------------------------------------------------------------
// Grounded flow
// ---------------------------------------------------------------------------

/** Step 1+2: the English answer and its key concepts. */
async function generateEnglishAndConcepts(
  question: string,
  apiKey: string,
  signal: AbortSignal
): Promise<{ english: string; concepts: string[] } | null> {
  const obj = await callGemini(
    SYSTEM_ENGLISH,
    question,
    SCHEMA_ENGLISH,
    apiKey,
    signal
  );
  if (!obj) {
    return null;
  }
  const { english, concepts } = obj;
  if (typeof english !== "string" || english.length === 0) {
    return null;
  }
  const conceptList = Array.isArray(concepts)
    ? concepts.filter(
        (c): c is string => typeof c === "string" && c.trim().length > 0
      )
    : [];
  return { english, concepts: conceptList };
}

/** English lemmas an English concept should be looked up under. */
function lookupKeys(concept: string): string[] {
  const base = concept.toLowerCase().replace(/\s+/g, " ").trim();
  const keys = new Set<string>([base]);
  // Cheap morphological fallbacks toward the dictionary's lemma form.
  if (base.endsWith("ies") && base.length > 4) keys.add(base.slice(0, -3) + "y");
  if (base.endsWith("es") && base.length > 3) keys.add(base.slice(0, -2));
  if (base.endsWith("s") && base.length > 2) keys.add(base.slice(0, -1));
  if (base.endsWith("ing") && base.length > 4) {
    keys.add(base.slice(0, -3));
    keys.add(base.slice(0, -3) + "e");
  }
  if (base.endsWith("ed") && base.length > 3) {
    keys.add(base.slice(0, -2));
    keys.add(base.slice(0, -1));
  }
  // Klingon qualities are "be X" adjectival verbs.
  keys.add("be " + base);
  return [...keys];
}

/** Step 3: resolve concepts to verified, canonical Klingon roots. */
function verifiedVocabulary(concepts: string[]): LexiconSense[] {
  const seen = new Set<string>();
  const result: LexiconSense[] = [];

  for (const concept of concepts) {
    if (result.length >= MAX_VOCABULARY) break;
    let taken = 0;
    for (const key of lookupKeys(concept)) {
      const senses = lexicon.englishToKlingon[key];
      if (!senses) continue;
      for (const sense of senses) {
        if (!sense.canon) continue; // verified canon roots only
        const id = `${sense.klingon}|${sense.pos}|${sense.homophone ?? ""}`;
        if (seen.has(id)) continue;
        seen.add(id);
        result.push(sense);
        if (++taken >= MAX_SENSES_PER_CONCEPT) break;
        if (result.length >= MAX_VOCABULARY) break;
      }
      if (taken >= MAX_SENSES_PER_CONCEPT || result.length >= MAX_VOCABULARY) {
        break;
      }
    }
  }
  return result;
}

/** Human-readable part of speech for the vocabulary list. */
function posLabel(sense: LexiconSense): string {
  switch (sense.pos) {
    case "v":
      return sense.tags.includes("is") ? "verb, adjectival (be ...)" : "verb";
    case "n":
      return "noun";
    case "adv":
      return "adverb";
    case "conj":
      return "conjunction";
    case "ques":
      return "question word";
    case "num":
      return "number";
    case "pro":
      return "pronoun";
    case "excl":
      return "exclamation";
    case "sen":
      return "phrase";
    default:
      return sense.pos;
  }
}

function formatVocabulary(vocab: LexiconSense[]): string {
  return vocab
    .map((s) => `- ${s.klingon} — ${s.gloss} [${posLabel(s)}]`)
    .join("\n");
}

/** Step 4: assemble the verified words into grounded Klingon. */
async function generateKlingon(
  english: string,
  vocab: LexiconSense[],
  apiKey: string,
  signal: AbortSignal
): Promise<{ klingon: string; backTranslation: string } | null> {
  const userText = `VERIFIED VOCABULARY (klingon — gloss [part of speech]) — the ONLY content roots you may use:
${formatVocabulary(vocab)}

ENGLISH ANSWER TO RENDER IN KLINGON:
"""
${english}
"""`;

  const obj = await callGemini(
    SYSTEM_KLINGON,
    userText,
    SCHEMA_KLINGON,
    apiKey,
    signal
  );
  if (!obj) {
    return null;
  }
  const { klingon, backTranslation } = obj;
  if (
    typeof klingon === "string" &&
    klingon.length > 0 &&
    typeof backTranslation === "string" &&
    backTranslation.length > 0
  ) {
    return { klingon, backTranslation };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Grounded flow (generate and return immediately; validation is separate)
// ---------------------------------------------------------------------------

/** Orchestrates the grounded two-step flow into a full payload. */
async function generateGroundedAnswer(
  question: string,
  apiKey: string,
  signal: AbortSignal
): Promise<AnswerPayload | null> {
  let ec: { english: string; concepts: string[] } | null = null;
  for (let attempt = 0; attempt < 2 && !ec; attempt++) {
    ec = await generateEnglishAndConcepts(question, apiKey, signal);
  }
  if (!ec) {
    return null;
  }

  // Answer concepts first (they take priority under the cap); seed concepts
  // backfill so the Klingon step always has verified material to work with.
  const vocab = verifiedVocabulary([...ec.concepts, ...SEED_CONCEPTS]);

  let kl: { klingon: string; backTranslation: string } | null = null;
  for (let attempt = 0; attempt < 2 && !kl; attempt++) {
    kl = await generateKlingon(ec.english, vocab, apiKey, signal);
  }
  if (!kl) {
    return null;
  }

  // pIqaD is never model output: LLMs can't reliably emit PUA codepoints, so
  // it's transliterated deterministically from the Latin transcription.
  return {
    english: ec.english,
    klingon: kl.klingon,
    pIqaD: toPiqad(kl.klingon),
    backTranslation: kl.backTranslation,
  };
}

/** Fallback: the previous single-call generation, for graceful degradation. */
async function generateLegacyAnswer(
  question: string,
  apiKey: string,
  signal: AbortSignal
): Promise<AnswerPayload | null> {
  const obj = await callGemini(
    SYSTEM_LEGACY,
    question,
    SCHEMA_LEGACY,
    apiKey,
    signal
  );
  if (!obj) {
    return null;
  }
  const { english, klingon, backTranslation } = obj;
  if (
    typeof english === "string" &&
    english.length > 0 &&
    typeof klingon === "string" &&
    klingon.length > 0 &&
    typeof backTranslation === "string" &&
    backTranslation.length > 0
  ) {
    return { english, klingon, pIqaD: toPiqad(klingon), backTranslation };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  if (!perIpLimiter.tryHit(clientIp(request)) || !globalLimiter.tryHit()) {
    return NextResponse.json(
      {
        error:
          "The demo is popular right now — give it a few seconds and try again.",
      },
      { status: 429, headers: { "Retry-After": "15" } }
    );
  }

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
    // Primary: grounded, lexicon-backed generation. Returns immediately; the
    // client verifies morphology separately via /api/verify.
    const grounded = await generateGroundedAnswer(question, apiKey, signal);
    if (grounded) {
      return NextResponse.json(grounded);
    }
    // Degrade rather than fail: fall back to the single-call generation.
    const legacy = await generateLegacyAnswer(question, apiKey, signal);
    if (legacy) {
      return NextResponse.json(legacy);
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

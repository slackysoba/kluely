// app/api/answer/route.ts
//
// Turns an interview question into a strong English answer plus its Klingon
// rendering. The Klingon is *grounded* and rendered with a simplify-then-
// translate pipeline so it stays faithful despite Klingon's tiny vocabulary:
//   1. generate the polished English answer (shown to the user), AND, in the
//      same call, SIMPLIFY it into short concrete literal propositions that
//      preserve the main idea — substituting specific nouns Klingon lacks
//      (salmon -> fish, lemon -> sour fruit) rather than dropping them — plus
//      the concrete concepts to look up,
//   2. look those concepts up in the canonical boQwI' lexicon
//      (data/klingon-lexicon.json) to get verified, attested Klingon roots,
//   3. hand the verified roots + the PROPOSITIONS to a second model call that
//      translates them with correct morphology and OVS order, substituting a
//      nearby verified word for anything missing and falling back to a
//      transliterated loanword only as a last resort — never silently dropping.

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

const SYSTEM_ENGLISH = `You are an elite interview coach AND a translation pre-processor for Klingon, a language with a small, concrete vocabulary and no abstraction. The user gives you an interview question. Produce THREE things.

1. "english" — the strongest possible answer for a candidate to give: specific, confident, structured; no filler, no "great question", no hedging. Two to three sentences. This is shown to the user verbatim, so keep it polished and natural.

2. "propositions" — the SAME answer rewritten for translation into Klingon. THIS IS THE MOST IMPORTANT STEP FOR FIDELITY. Klingon can't handle abstraction, so decompose the answer into short, literal, declarative statements (simple subject–verb–object), and:
   - Preserve the MAIN IDEA and the part that actually answers the question. Do NOT genericize it into something merely thematically related.
   - Replace abstract or idiomatic phrasing with concrete actions and things: "I optimized the deployment pipeline" → "I made the work faster"; "I take ownership" → "I fix problems myself"; "I built rapport" → "I made friends".
   - For a specific noun Klingon almost certainly lacks, SUBSTITUTE it here in English — never drop it, or the answer stops answering the question:
       * First choice: a more general word that keeps the point (salmon → fish; sedan → car; React → a computer tool).
       * Second choice: a short concrete description in common words (lemon → sour fruit; grill → cook over fire).
     Keep the specific idea as recoverable as possible.
   - 2 to 5 short propositions.

3. "concepts" — the concrete content words from your PROPOSITIONS (after substitutions), as simple dictionary-lookup lemmas: verbs uninflected ("lead" not "led"), nouns singular ("goal" not "goals"), qualities as plain adjectives ("brave"). Add close synonyms for anything that might be missing (e.g. "team" → also "group"). 8 to 16, ordered by importance.

Return strict JSON: { "english": ..., "propositions": [...], "concepts": [...] }.`;

const SCHEMA_ENGLISH = {
  type: "OBJECT",
  properties: {
    english: {
      type: "STRING",
      description:
        "A strong, concise interview answer. 2-3 sentences, specific and confident. Shown to the user verbatim.",
    },
    propositions: {
      type: "ARRAY",
      description:
        "2-5 short, literal, concrete declarative statements that preserve the answer's main idea but avoid abstraction/idiom, with hard-to-translate specific nouns substituted (not dropped). This is what gets translated to Klingon.",
      items: { type: "STRING" },
    },
    concepts: {
      type: "ARRAY",
      description:
        "8-16 concrete content lemmas drawn from the propositions (after substitutions), for Klingon dictionary lookup, including close synonyms.",
      items: { type: "STRING" },
    },
  },
  required: ["english", "propositions", "concepts"],
  propertyOrdering: ["english", "propositions", "concepts"],
} as const;

const SYSTEM_KLINGON = `${KLINGON_GRAMMAR_PRIMER}

---

# GROUNDING OVERRIDE — takes precedence over any vocabulary shown in the primer above

You are translating pre-simplified English propositions into Klingon, grounded in a verified vocabulary list. Everything above is your GRAMMAR reference only — its example words are illustrations, not a vocabulary you may draw from.

The user message gives you:
  - VERIFIED VOCABULARY: canonical Klingon roots (from the boQwI' dictionary) with their exact glosses. Prefer these content roots.
  - SIMPLIFIED PROPOSITIONS: short, concrete, literal statements already decomposed for you. Translate THESE faithfully — do not re-abstract them or add flourish.

Hard rules:
1. Content roots (nouns, verbs, adjectival verbs, adverbs): PREFER roots from the VERIFIED VOCABULARY list; do not pull other roots from the primer examples or your own memory. When a proposition needs a concrete word that is NOT in the list, in this priority order:
   a. SUBSTITUTE first: express it with the closest available verified word — a broader category, or a short description built from available words (e.g. if "fish" is absent, use "animal" or "food"; render "sour fruit" as "food" plus a quality). Keep it as specific as the vocabulary allows.
   b. LOANWORD only if necessary: if no reasonable substitute exists and dropping the word would lose the point of the answer, transliterate the English word into Klingon spelling using ONLY Klingon letters (consonants: b ch D gh H j l m n ng p q Q r S t tlh v w y ' ; vowels: a e I o u). Use loanwords sparingly — they are a last resort.
   c. NEVER silently drop a concrete noun that carries the answer. Substitute or, failing that, loanword.
2. You MAY freely use the grammatical apparatus described in the primer: verb prefixes, verb suffixes, noun suffixes, the pronouns (jIH, SoH, ghaH, 'oH, maH, tlhIH, chaH), conjunctions ('ej, 'ach, vaj, pagh, qoj, 'e'), numbers, and the fixed set phrases (Qapla', majQa', nuqneH, lu'/luq).
3. Apply correct Klingon morphology (attach prefixes and suffixes per the primer) and strict OVS (Object–Verb–Subject) word order.
4. Translate every proposition — keep the concrete content. Keep it tight; a faithful literal rendering beats a padded one.

Return strict JSON with exactly two fields:
  - "klingon": the rendering in Latin transcription, correct capitalization, OVS order.
  - "backTranslation": a literal, structure-revealing English back-translation (deliberately awkward, revealing the Klingon structure). Preserve any loanword as-is and, in brackets, note what it stands for.
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

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (v): v is string => typeof v === "string" && v.trim().length > 0
      )
    : [];
}

/**
 * Step 1: the polished English answer (shown to the user), plus its
 * simplify/decompose products — concrete literal propositions to translate and
 * the concrete concepts to ground the vocabulary lookup on.
 */
async function generateEnglishAndSimplification(
  question: string,
  apiKey: string,
  signal: AbortSignal
): Promise<{ english: string; propositions: string[]; concepts: string[] } | null> {
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
  const { english } = obj;
  if (typeof english !== "string" || english.length === 0) {
    return null;
  }
  // Fall back to translating the polished answer if the model returned no
  // propositions, so the pipeline still produces Klingon.
  const propositions = stringList(obj.propositions);
  return {
    english,
    propositions: propositions.length > 0 ? propositions : [english],
    concepts: stringList(obj.concepts),
  };
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

/** Step 3: translate the simplified propositions into grounded Klingon. */
async function generateKlingon(
  propositions: string[],
  vocab: LexiconSense[],
  apiKey: string,
  signal: AbortSignal
): Promise<{ klingon: string; backTranslation: string } | null> {
  const userText = `VERIFIED VOCABULARY (klingon — gloss [part of speech]) — prefer these content roots:
${formatVocabulary(vocab)}

SIMPLIFIED PROPOSITIONS TO RENDER IN KLINGON (translate these literal statements faithfully):
${propositions.map((p, i) => `${i + 1}. ${p}`).join("\n")}`;

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

/** Orchestrates the simplify-then-translate flow into a full payload. */
async function generateGroundedAnswer(
  question: string,
  apiKey: string,
  signal: AbortSignal
): Promise<AnswerPayload | null> {
  let ec:
    | { english: string; propositions: string[]; concepts: string[] }
    | null = null;
  for (let attempt = 0; attempt < 2 && !ec; attempt++) {
    ec = await generateEnglishAndSimplification(question, apiKey, signal);
  }
  if (!ec) {
    return null;
  }

  // Answer concepts first (they take priority under the cap); seed concepts
  // backfill so the Klingon step always has verified material to work with.
  const vocab = verifiedVocabulary([...ec.concepts, ...SEED_CONCEPTS]);

  // Translate the simplified propositions, not the polished answer.
  let kl: { klingon: string; backTranslation: string } | null = null;
  for (let attempt = 0; attempt < 2 && !kl; attempt++) {
    kl = await generateKlingon(ec.propositions, vocab, apiKey, signal);
  }
  if (!kl) {
    return null;
  }

  // pIqaD is never model output: LLMs can't reliably emit PUA codepoints, so
  // it's transliterated deterministically from the Latin transcription. The
  // displayed English stays the polished answer, not the propositions.
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

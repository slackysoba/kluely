// Klingon morphology confidence.
//
// Calls the yajwiz validator serverless function (api/validate-klingon.py) and
// turns its per-word results into a "high" | "low" confidence signal. This is
// deliberately separate from generation so it can run *off* the answer's
// critical path (see app/api/verify): the Klingon shows immediately, and the
// confidence marker resolves a moment later.

import { isKlingonWord } from "@/lib/klingon-orthography";

const VALIDATOR_PATH = "/api/validate-klingon";
const VALIDATOR_TIMEOUT_MS = 7_000;

/**
 * Where the yajwiz validator lives. By default it's a same-origin Python
 * serverless function (api/validate-klingon.py). But Vercel doesn't reliably
 * route a standalone Python function bundled inside a Next.js project, so
 * KLINGON_VALIDATOR_URL lets you point at the validator deployed as its OWN
 * Vercel project (zero-config Python, which deploys reliably). Set it to that
 * project's full endpoint, e.g. https://kluely-validator.vercel.app/api/validate-klingon.
 * Unset → same-origin, i.e. exactly the previous behaviour.
 */
function validatorEndpoint(origin: string): URL {
  const override = process.env.KLINGON_VALIDATOR_URL;
  return override && override.length > 0
    ? new URL(override)
    : new URL(VALIDATOR_PATH, origin);
}
// Below this share of the Klingon's validated meaning mapping back to the
// intended English, the rendering is treated as having drifted.
const MEANING_ALIGNMENT_MIN = 0.25;

export type Confidence = "high" | "low";

export interface ValidationMorpheme {
  text?: string | null;
  pos?: string | null;
  gloss?: string | null;
}
export interface ValidationAnalysis {
  lemma?: string | null;
  pos?: string | null; // "N" | "V" | "OTHER"
  boqwizPos?: string | null; // e.g. "n:body,klcp1" — carries noun class
  gloss?: string | null;
  prefix?: string | null;
  suffixes?: string[];
  morphemes?: ValidationMorpheme[];
}
export interface ValidationWord {
  word: string;
  valid: boolean;
  // false when the analyzer found no analysis at all (unknown root) — the
  // signature of a loanword or out-of-dictionary word, as opposed to a known
  // root assembled ungrammatically (parses: true, valid: false).
  parses?: boolean;
  analyses?: ValidationAnalysis[];
}
export interface ValidationResult {
  words: ValidationWord[];
}

/**
 * A word is acceptable if the analyzer validated it, OR it's a plausible
 * loanword: unknown to the analyzer (no parse) yet properly transliterated
 * into Klingon letters. A word that parses but is flagged ungrammatical is a
 * genuine morphology error, and raw English (non-Klingon orthography) is not
 * accepted.
 */
function acceptableWord(w: ValidationWord): boolean {
  if (w.valid) {
    return true;
  }
  return w.parses === false && isKlingonWord(w.word);
}

/** Calls the Python validator. Best-effort: returns null on any failure. */
export async function validateKlingon(
  klingon: string,
  origin: string,
  signal: AbortSignal
): Promise<ValidationResult | null> {
  try {
    const res = await fetch(validatorEndpoint(origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: klingon }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(VALIDATOR_TIMEOUT_MS)]),
    });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as ValidationResult;
    return Array.isArray(data.words) ? data : null;
  } catch {
    // Unreachable/timed-out validator, or 404 in a validator-less environment.
    return null;
  }
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with",
  "as", "at", "by", "is", "are", "was", "be", "been", "it", "its", "this",
  "that", "these", "those", "you", "your", "our", "we", "they", "them", "their",
  "i", "my", "me", "will", "can", "not", "no", "one", "who", "which", "what",
  "have", "has", "had", "do", "does", "did", "from", "into", "than", "then",
]);

/** Lower-cased content words of a phrase, minus stopwords and short tokens. */
function contentTokens(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
  return new Set(tokens);
}

/**
 * Whether the Klingon's *validated* meaning (the glosses yajwiz resolved for
 * each word) reflects the intended English. Lenient: only clear drift, where
 * almost none of the Klingon's meaning maps back to the intent, counts as
 * divergence — good paraphrases must not be punished.
 */
function meaningAligned(english: string, v: ValidationResult): boolean {
  const intended = contentTokens(english);
  const meaning = new Set<string>();
  for (const word of v.words) {
    const a = word.analyses?.[0];
    if (!a) continue;
    if (a.gloss) for (const t of contentTokens(a.gloss)) meaning.add(t);
    for (const m of a.morphemes ?? []) {
      if (m.gloss) for (const t of contentTokens(m.gloss)) meaning.add(t);
    }
  }
  if (meaning.size === 0) {
    return true; // Nothing to compare against; don't penalise.
  }
  let overlap = 0;
  for (const t of meaning) if (intended.has(t)) overlap++;
  return overlap / meaning.size >= MEANING_ALIGNMENT_MIN || overlap >= 3;
}

// Verb/noun prefix meanings (Okrand's paradigm). Used to reveal subject→object
// in the morphological back-translation. Unmapped prefixes fall back to their
// surface form, so we never assert a meaning we're unsure of.
const PREFIX_GLOSS: Record<string, string> = {
  jI: "I",
  bI: "you",
  ma: "we",
  Su: "you(pl)",
  vI: "I→it",
  qa: "I→you",
  Sa: "I→you(pl)",
  wI: "we→it",
  pI: "we→you",
  re: "we→you(pl)",
  Da: "you→it",
  cho: "you→me",
  ju: "you→us",
  bo: "you(pl)→it",
  tu: "you(pl)→me",
  che: "you(pl)→us",
  mu: "he/it→me",
  Du: "he/it→you",
  nu: "he/it→us",
  lI: "he/it→you(pl)",
  lu: "they→it",
  nI: "they→you(pl)",
  yI: "you!",
  HI: "you→me!",
  gho: "you→us!",
  tI: "you→them!",
  pe: "you(pl)!",
};

/** Compact form of a boQwI' gloss: first sense, parentheticals removed. */
function shortGloss(gloss: string): string {
  return gloss
    .split(/[;,]/)[0]
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Morpheme-by-morpheme gloss of one analyzed word, from the yajwiz parse. */
function wordGloss(word: ValidationWord): string {
  const analysis = word.analyses?.[0];
  // Unknown to the analyzer (a loanword) — keep the coined word verbatim.
  if (!analysis) {
    return word.word;
  }
  const segments: string[] = [];
  if (analysis.prefix) {
    const key = analysis.prefix.replace(/[^A-Za-z']/g, "");
    if (key) segments.push(PREFIX_GLOSS[key] ?? `${key}-`);
  }
  const morphemes = analysis.morphemes ?? [];
  if (morphemes.length > 0) {
    for (const m of morphemes) {
      const g = m.gloss ? shortGloss(m.gloss) : (m.text ?? "").trim();
      if (g) segments.push(g);
    }
  } else {
    const g = analysis.gloss
      ? shortGloss(analysis.gloss)
      : (analysis.lemma ?? word.word);
    if (g) segments.push(g);
  }
  return segments.join("-") || word.word;
}

/**
 * A literal, structure-revealing back-translation built strictly from the
 * yajwiz morphological parse (root + affix glosses, in Klingon word order) —
 * never an LLM re-translation.
 */
export function backTranslate(v: ValidationResult): string {
  return v.words.map(wordGloss).join(" ").trim();
}

/**
 * Verifies a Klingon rendering against the yajwiz parse, returning both the
 * confidence signal and the parse-derived literal back-translation.
 *
 * Confidence is "high" when every word is acceptable — valid Klingon morphology
 * or a properly-formed loanword — with at least one genuinely valid word (so an
 * all-loanword string can't pass), AND the validated meaning tracks the intended
 * English. Otherwise (including when the validator can't be reached) "low", and
 * the back-translation is whatever the parse yielded (empty when unavailable).
 */
export async function verifyKlingon(
  klingon: string,
  english: string,
  origin: string,
  signal: AbortSignal
): Promise<{ confidence: Confidence; backTranslation: string }> {
  const v = await validateKlingon(klingon, origin, signal);
  if (!v || v.words.length === 0) {
    return { confidence: "low", backTranslation: "" };
  }
  const morphologyOk =
    v.words.every(acceptableWord) && v.words.some((w) => w.valid);
  const confidence: Confidence =
    morphologyOk && meaningAligned(english, v) ? "high" : "low";
  return { confidence, backTranslation: backTranslate(v) };
}

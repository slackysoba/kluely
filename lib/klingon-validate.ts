// Klingon morphology confidence.
//
// Calls the yajwiz validator serverless function (api/validate-klingon.py) and
// turns its per-word results into a "high" | "low" confidence signal. This is
// deliberately separate from generation so it can run *off* the answer's
// critical path (see app/api/verify): the Klingon shows immediately, and the
// confidence marker resolves a moment later.

const VALIDATOR_PATH = "/api/validate-klingon";
const VALIDATOR_TIMEOUT_MS = 7_000;
// Below this share of the Klingon's validated meaning mapping back to the
// intended English, the rendering is treated as having drifted.
const MEANING_ALIGNMENT_MIN = 0.25;

export type Confidence = "high" | "low";

interface ValidationAnalysis {
  gloss?: string | null;
  morphemes?: { gloss?: string | null }[];
}
interface ValidationWord {
  word: string;
  valid: boolean;
  analyses?: ValidationAnalysis[];
}
interface ValidationResult {
  words: ValidationWord[];
}

/** Calls the Python validator. Best-effort: returns null on any failure. */
async function validateKlingon(
  klingon: string,
  origin: string,
  signal: AbortSignal
): Promise<ValidationResult | null> {
  try {
    const res = await fetch(new URL(VALIDATOR_PATH, origin), {
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

/**
 * Resolves a confidence signal for a Klingon rendering. "high" only when every
 * word parses as valid Klingon morphology AND the validated meaning tracks the
 * intended English; otherwise (including when the validator can't be reached)
 * "low", so we never claim verification we didn't get.
 */
export async function computeConfidence(
  klingon: string,
  english: string,
  origin: string,
  signal: AbortSignal
): Promise<Confidence> {
  const v = await validateKlingon(klingon, origin, signal);
  if (!v || v.words.length === 0) {
    return "low";
  }
  const morphologyOk = v.words.every((w) => w.valid);
  return morphologyOk && meaningAligned(english, v) ? "high" : "low";
}

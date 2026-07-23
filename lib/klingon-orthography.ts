// Klingon orthography helpers, shared by generation (to catch raw-English
// leaks and retry) and validation (to tell loanwords from genuine errors).

// The full Klingon letter set (case-sensitive), digraphs first so they win the
// match: consonants b ch D gh H j l m n ng p q Q r S t tlh v w y ' and the
// vowels a e I o u.
const KLINGON_LETTER = /(tlh|ch|gh|ng|[bDHjlmnpqQrStvwy']|[aeIou])/g;

/**
 * True when a token is spelled entirely with Klingon letters — a real word, or
 * a properly transliterated loanword. A raw English word like "clever" (the
 * bare "c" isn't a Klingon letter) returns false.
 */
export function isKlingonWord(word: string): boolean {
  return word.length > 0 && word.replace(KLINGON_LETTER, "").length === 0;
}

/**
 * The distinct word tokens in a Klingon string that are NOT valid Klingon
 * orthography — i.e. raw English or otherwise non-Klingon tokens that must
 * never remain in the output. Splits on whitespace and strips surrounding
 * punctuation, but keeps the apostrophe (a Klingon consonant).
 */
export function nonKlingonTokens(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\s+/)) {
    // Trim leading/trailing punctuation, but not the apostrophe (glottal stop).
    const token = raw.replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, "");
    if (!token) {
      continue;
    }
    if (!isKlingonWord(token) && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

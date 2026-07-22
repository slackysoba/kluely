// Deterministic Latin → pIqaD transliteration, per the ConScript Unicode
// Registry assignment (U+F8D0–U+F8FF). We never ask the LLM to emit these
// codepoints: PUA characters are effectively absent from training data, so
// models substitute lookalikes (typically CJK). Mapping mechanically from
// the Latin transcription is guaranteed correct.

// Longest match first: the digraphs ch/gh/ng/tlh are single pIqaD letters.
const LETTERS: ReadonlyArray<readonly [string, string]> = [
  ["tlh", "\uF8E4"],
  ["ch", "\uF8D2"],
  ["gh", "\uF8D5"],
  ["ng", "\uF8DC"],
  ["a", "\uF8D0"],
  ["b", "\uF8D1"],
  ["D", "\uF8D3"],
  ["e", "\uF8D4"],
  ["H", "\uF8D6"],
  ["I", "\uF8D7"],
  ["j", "\uF8D8"],
  ["l", "\uF8D9"],
  ["m", "\uF8DA"],
  ["n", "\uF8DB"],
  ["o", "\uF8DD"],
  ["p", "\uF8DE"],
  ["q", "\uF8DF"],
  ["Q", "\uF8E0"],
  ["r", "\uF8E1"],
  ["S", "\uF8E2"],
  ["t", "\uF8E3"],
  ["u", "\uF8E5"],
  ["v", "\uF8E6"],
  ["w", "\uF8E7"],
  ["y", "\uF8E8"],
  ["'", "\uF8E9"],
  ["\u2019", "\uF8E9"], // tolerate typographic apostrophes
  ["0", "\uF8F0"],
  ["1", "\uF8F1"],
  ["2", "\uF8F2"],
  ["3", "\uF8F3"],
  ["4", "\uF8F4"],
  ["5", "\uF8F5"],
  ["6", "\uF8F6"],
  ["7", "\uF8F7"],
  ["8", "\uF8F8"],
  ["9", "\uF8F9"],
];

/**
 * Transliterates Klingon in Latin transcription to pIqaD (CSUR PUA).
 * Capitalization is orthographically significant and matched exactly
 * (q and Q are different letters). Characters outside the Klingon
 * alphabet — spaces, punctuation — pass through unchanged.
 */
export function toPiqad(latin: string): string {
  let out = "";
  let i = 0;
  outer: while (i < latin.length) {
    for (const [letter, glyph] of LETTERS) {
      if (latin.startsWith(letter, i)) {
        out += glyph;
        i += letter.length;
        continue outer;
      }
    }
    out += latin[i];
    i += 1;
  }
  return out;
}

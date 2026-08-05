// General English morphology → lemma-candidate expansion.
//
// The Klingon lexicon is keyed on the *surface words of dictionary glosses*
// (e.g. "decide", "lead, guide", "be intelligent"), which are almost always
// base/lemma forms. But the concepts the model hands us are whatever English it
// produced — inflected ("led", "leading") and, more damagingly, *derived*
// ("leadership", "decision", "management", "creation"). None of those hit the
// index, so grounding silently misses the word even when the Klingon root is
// right there under a related gloss.
//
// This module maps an arbitrary English word toward the lemma forms a gloss is
// likely to use, using rule-based inflectional + derivational stripping. It is
// deliberately over-generative: a spurious candidate simply fails to match a
// real index key, so the cost of a wrong guess is nil, while a right guess
// reclaims an attested root. Ordered most-faithful-first so callers that take
// canon-first up to a cap still prefer the direct sense.

/** Drop a doubled final consonant: "runn" → "run", "bigg" → "big". */
function undouble(stem: string): string | null {
  return /([^aeiou])\1$/.test(stem) ? stem.slice(0, -1) : null;
}

// Irregular inflections the suffix rules can't reach: strong-verb past/participle
// and irregular plurals map straight to their lemma. General English, not
// domain-specific.
const IRREGULAR: Record<string, string> = {
  // strong-verb past / participle → base
  led: "lead", fed: "feed", met: "meet", held: "hold", told: "tell",
  sold: "sell", built: "build", sent: "send", spent: "spend", kept: "keep",
  slept: "sleep", felt: "feel", left: "leave", lost: "lose", meant: "mean",
  dealt: "deal", found: "find", bound: "bind", ground: "grind", wound: "wind",
  fought: "fight", sought: "seek", taught: "teach", caught: "catch",
  brought: "bring", thought: "think", bought: "buy",
  knew: "know", known: "know", grew: "grow", grown: "grow", threw: "throw",
  thrown: "throw", flew: "fly", flown: "fly", drew: "draw", drawn: "draw",
  blew: "blow", blown: "blow", went: "go", gone: "go", did: "do", done: "do",
  saw: "see", seen: "see", ate: "eat", eaten: "eat", gave: "give",
  given: "give", took: "take", taken: "take", came: "come", ran: "run",
  began: "begin", begun: "begin", drank: "drink", drunk: "drink", sang: "sing",
  sung: "sing", swam: "swim", spoke: "speak", spoken: "speak", broke: "break",
  broken: "break", chose: "choose", chosen: "choose", wrote: "write",
  written: "write", rode: "ride", ridden: "ride", drove: "drive",
  driven: "drive", rose: "rise", risen: "rise", stole: "steal",
  stolen: "steal", wore: "wear", worn: "wear", tore: "tear", torn: "tear",
  froze: "freeze", frozen: "freeze", was: "be", were: "be", been: "be",
  had: "have", made: "make", said: "say", got: "get", gotten: "get",
  stood: "stand", understood: "understand", won: "win", shot: "shoot",
  // irregular plurals → singular
  children: "child", men: "man", women: "woman", feet: "foot", teeth: "tooth",
  mice: "mouse", geese: "goose", people: "person", lives: "life",
  wives: "wife", knives: "knife", leaves: "leaf", wolves: "wolf",
  selves: "self", enemies: "enemy",
};

// Derivational suffixes → the base form(s) they were built from. Each entry is
// tried when the word ends in `suf`; `out` receives the word with `suf` removed
// and returns plausible bases (variants cover the silent-e and irregular joins
// English drops at the boundary). Over-generation is fine — see file header.
const DERIVATIONS: { suf: string; out: (s: string) => string[] }[] = [
  // Nominalisations of verbs.
  { suf: "ation", out: (s) => [s + "e", s] }, // information→inform, creation→create*
  { suf: "ition", out: (s) => [s + "e", s] }, // competition→compete, definition→define
  { suf: "ption", out: (s) => [s + "be", s + "t"] }, // absorption→absorb, exception→except
  { suf: "sion", out: (s) => [s + "de", s + "d", s + "t", s + "se"] }, // decision→decide, expansion→expand
  { suf: "ion", out: (s) => [s, s + "e"] }, // action→act, creation→create
  { suf: "ment", out: (s) => [s, s + "e"] }, // management→manage, agreement→agree
  { suf: "ance", out: (s) => [s, s + "e"] }, // performance→perform, guidance→guide
  { suf: "ence", out: (s) => [s, s + "e"] }, // difference→differ, existence→exist
  { suf: "ness", out: (s) => [s] }, // hardness→hard
  { suf: "ship", out: (s) => [s] }, // leadership→leader (chains → lead)
  { suf: "hood", out: (s) => [s] }, // brotherhood→brother
  { suf: "ity", out: (s) => [s, s + "e"] }, // activity→active, creativity→creative
  { suf: "ty", out: (s) => [s] }, // safety→safe*, honesty→honest
  // De-adjectival / agentive / relational.
  { suf: "ical", out: (s) => [s, s + "y"] }, // historical→history*, logical→logic
  { suf: "ic", out: (s) => [s, s + "y"] }, // strategic→strategy*, heroic→hero
  { suf: "ive", out: (s) => [s, s + "e"] }, // creative→create, supportive→support
  { suf: "able", out: (s) => [s, s + "e"] }, // manageable→manage, valuable→value
  { suf: "ible", out: (s) => [s, s + "e"] }, // responsible→respond*
  { suf: "ful", out: (s) => [s] }, // helpful→help, careful→care
  { suf: "less", out: (s) => [s] }, // useless→use, careless→care
  { suf: "ally", out: (s) => [s, s + "y", s + "ic"] }, // strategically→strategic
  { suf: "ily", out: (s) => [s + "y"] }, // happily→happy
  { suf: "ly", out: (s) => [s] }, // quickly→quick, really→real
  { suf: "al", out: (s) => [s, s + "e"] }, // approval→approve, personal→person
  { suf: "or", out: (s) => [s, s + "e"] }, // actor→act, creator→create
  { suf: "ar", out: (s) => [s] }, // liar→lie*, beggar→beg
  { suf: "en", out: (s) => [s, s + "e"] }, // strengthen→strength, widen→wide
  { suf: "y", out: (s) => [s] }, // risky→risk, healthy→health, wordy→word
];

// Negation / reversal prefixes: strip to reach the positive base ("unhappy" →
// "happy", "impossible" → "possible", "disagree" → "agree").
const NEG_PREFIXES = ["un", "im", "in", "ir", "il", "dis", "non", "mis", "over", "under", "re"];

/** One level of inflectional + derivational stripping. Never includes `w`. */
function strip(w: string): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (s.length < 2) return;
    out.push(s);
    // English swaps y→i before many suffixes; undo it (happiness→happi→happy,
    // easily→easi→easy, activities→activi→...→active handled elsewhere).
    if (s.endsWith("i")) out.push(s.slice(0, -1) + "y");
  };

  // --- Irregular forms (exact) ---
  if (IRREGULAR[w]) add(IRREGULAR[w]);

  // --- Inflection ---
  if (w.endsWith("ies") && w.length > 4) add(w.slice(0, -3) + "y");
  if (w.endsWith("ves") && w.length > 4) add(w.slice(0, -3) + "f"); // lives→life-ish, leaves→leaf
  if (w.endsWith("es") && w.length > 3) add(w.slice(0, -2));
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) add(w.slice(0, -1));
  if (w.endsWith("ing") && w.length > 5) {
    const s = w.slice(0, -3);
    add(s);
    add(s + "e");
    const u = undouble(s);
    if (u) add(u);
  }
  if (w.endsWith("ied") && w.length > 4) add(w.slice(0, -3) + "y");
  if (w.endsWith("ed") && w.length > 4) {
    const s = w.slice(0, -2);
    add(s);
    add(s + "e");
    const u = undouble(s);
    if (u) add(u);
  }
  if (w.endsWith("est") && w.length > 4) {
    const s = w.slice(0, -3);
    add(s);
    add(s + "e");
    const u = undouble(s);
    if (u) add(u);
  }
  if (w.endsWith("er") && w.length > 4) {
    // Ambiguous: comparative (bigger→big), agentive (leader→lead, teacher→teach).
    const s = w.slice(0, -2);
    add(s);
    add(s + "e");
    const u = undouble(s);
    if (u) add(u);
  }

  // --- Derivation ---
  for (const { suf, out: make } of DERIVATIONS) {
    if (w.endsWith(suf) && w.length > suf.length + 2) {
      for (const cand of make(w.slice(0, -suf.length))) add(cand);
    }
  }

  // --- Negation / reversal prefixes ---
  for (const p of NEG_PREFIXES) {
    if (w.startsWith(p) && w.length > p.length + 2) add(w.slice(p.length));
  }

  return out;
}

/**
 * Lemma candidates for an English word, most-faithful-first: the word itself,
 * then its inflectional/derivational bases (two strip levels, so chains like
 * leadership → leader → lead resolve), then the "be X" adjectival-verb form
 * Klingon uses for qualities. Multi-word phrases are kept whole plus their head
 * and last word, without single-word morphology applied to the phrase.
 */
export function lemmaCandidates(word: string): string[] {
  const base = word.toLowerCase().replace(/[^a-z'\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!base) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  const add = (w?: string | null) => {
    if (!w) return;
    const k = w.trim();
    if (k.length < 2 || seen.has(k)) return;
    seen.add(k);
    out.push(k);
  };

  add(base);

  if (base.includes(" ")) {
    const words = base.split(" ");
    add(words[words.length - 1]);
    add(words[0]);
    add("be " + base);
    return out;
  }

  // Two levels of stripping so leadership→leader→lead, decisions→decision→decide.
  const level1 = strip(base);
  for (const f of level1) add(f);
  for (const f of level1) for (const g of strip(f)) add(g);

  // Klingon renders qualities as "be X" adjectival verbs.
  add("be " + base);
  return out;
}

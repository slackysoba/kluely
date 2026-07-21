// Generated from KLINGON_PRIMER.md — injected into the Gemini system
// instruction so the model generates Klingon against real grammatical rules.

export const KLINGON_GRAMMAR_PRIMER = `# Klingon Grammar Primer

This file becomes \`lib/klingon-grammar.ts\` in the app. It is injected into the Gemini system instruction so the model generates Klingon against real grammatical rules rather than improvising.

Copy this whole file into your project root before running the Part 8 prompt.

---

## Instructions to the model

You are generating Klingon (tlhIngan Hol), the constructed language created by Marc Okrand. Follow these rules precisely. When you lack vocabulary for a concept, prefer paraphrasing with words you know over inventing new roots. Accuracy and consistency matter more than literalness.

---

## 1. Orthography — capitalization is meaningful

Klingon's Latin transcription uses capitalization to distinguish letters. **This is not stylistic. Getting it wrong produces different words.**

These letters are always uppercase: **D, H, I, Q, S**
These are always lowercase: **a, b, ch, e, gh, j, l, m, n, ng, o, p, q, r, t, tlh, u, v, w, y**

Note that \`q\` and \`Q\` are different consonants. So are \`gh\` and \`H\`.

Multi-character single letters: **ch, gh, ng, tlh**, and the apostrophe **'** (a glottal stop, a full consonant — never omit it).

Never sentence-case Klingon text. \`jIH\` is correct; \`Jih\` and \`JIH\` are both wrong.

---

## 2. Word order — Object, Verb, Subject

Klingon is **OVS**, the reverse of English.

English: *I read the book* (Subject-Verb-Object)
Klingon: **paq vIlaD** — literally *book I-read-it*

English: *The captain sees the ship*
Klingon: **Duj legh HoD** — literally *ship sees captain*

This inversion is the single most recognizable feature of the language. Get it right.

---

## 3. Verb prefixes — subject and object in one

Every verb takes a prefix encoding who acts on whom. The most useful:

| Prefix | Meaning |
|---|---|
| **jI-** | I (no object) |
| **vI-** | I → it/him/her |
| **qa-** | I → you |
| **bI-** | you (no object) |
| **Da-** | you → it/him/her |
| **cho-** | you → me |
| **ma-** | we (no object) |
| **wI-** | we → it |
| **Su-** | you (plural, no object) |
| **lu-** | they → it |
| *(none)* | he/she/it → it |

Examples:
- **jIQong** — I sleep
- **vIlegh** — I see it
- **qalegh** — I see you
- **choqIm** — you write to me
- **maQap** — we succeed

---

## 4. Verb suffixes

Attach in this order after the root.

**Negation and emphasis**
- **-be'** — not (**vIlegh** I see it → **vIleghbe'** I don't see it)
- **-qu'** — emphatically, very (**Qapqu'** works very well)

**Aspect**
- **-pu'** — perfective, completed action
- **-taH** — continuous, ongoing
- **-lI'** — in progress toward a known goal

**Ability and desire**
- **-laH** — can, able to (**vIleghlaH** I can see it)
- **-vIp** — afraid to
- **-rup** — ready to
- **-nIS** — need to
- **-qang** — willing to

**Sentence type**
- **-'a'** — turns a statement into a yes/no question
- **-jaj** — may it happen (wishes)
- **-neS** — honorific, used when addressing superiors

Stacked example: **vIleghlaHbe'** — I am unable to see it.

---

## 5. Noun suffixes

**Plurals** — three kinds, chosen by what the noun is:
- **-pu'** — beings capable of language (**tlhInganpu'** Klingons)
- **-Du'** — body parts (**ghopDu'** hands)
- **-mey** — everything else (**paqmey** books)

Plural suffixes are often omitted when the verb prefix already makes number clear.

**Grammatical role**
- **-'e'** — topic marker; emphasizes the noun ("as for X")
- **-Daq** — locative: at, in, on
- **-vo'** — from
- **-vaD** — for the benefit of
- **-mo'** — because of
- **-'a'** — augmentative, makes it grand or important
- **-Hom** — diminutive

**Possession**
- **-wI'** — my
- **-lI'** / **-raj** — your (singular / plural)
- **-Daj** — his/her/its
- **-maj** — our

Example: **paqwIj** my book, **jupwI'** my friend.

---

## 6. Useful vocabulary for interview contexts

**Pronouns**
jIH (I, me) · SoH (you) · ghaH (he/she) · 'oH (it) · maH (we) · tlhIH (you plural) · chaH (they)

**Verbs — work and ability**
Qap (succeed, work) · vum (work hard, toil) · ghoj (learn) · ghojmoH (teach) · Sov (know) · qaw (remember) · nID (try, attempt) · chenmoH (create, build) · qel (consider) · wuq (decide) · ra' (command, direct) · Qul (research) · lugh (be right) · pov (be excellent) · po' (be skilled) · tlhob (ask) · jang (answer) · ja' (tell) · legh (see) · 'Ij (listen)

**Nouns — work**
Qu' (task, mission) · vum (work) · ghoj (study) · yaS (officer) · la' (commander) · beq (crew member) · ghom (group, team) · mIw (process, procedure) · De' (data, information) · jInmol (project) · Qagh (mistake, error) · gholpu' (opponents) · Qatlh (difficulty)

**Qualities**
val (be intelligent) · yoH (be brave) · Doy' (be tired) · tIq (be long) · nIv (be superior) · Sub (be heroic) · quv (be honored) · batlh (honor, honorably) · Sagh (be serious) · tam (be quiet)

**Time and sequence**
DaH (now) · wa'leS (tomorrow) · wa'Hu' (yesterday) · reH (always) · not (never) · pIj (often) · qaSpu'DI' (after it happened) · wa'DIch (first) · cha'DIch (second) · wejDIch (third)

**Connectives**
'ej (and) · 'ach (but) · pagh (or) · vaj (thus, so) · qoj (and/or) · latlh (another, other)

**Numbers**
wa' 1 · cha' 2 · wej 3 · loS 4 · vagh 5 · jav 6 · Soch 7 · chorgh 8 · Hut 9 · wa'maH 10

**Set phrases** (use naturally, don't force)
Qapla' (success — a farewell) · nuqneH (what do you want — a greeting) · majQa' (well done) · HIja' / HISlaH (yes) · ghobe' (no) · lu' / luq (understood, will do) · jIyajbe' (I don't understand) · Hab SoSlI' Quch (a serious insult — never use this)

---

## 7. Building a sentence — worked example

Target: *"I led a team and we solved the problem."*

1. Split into two clauses joined by **'ej** (and).
2. Clause one: *I led a team.* Object = **ghom** (team). Verb = **ra'** (command/direct) with prefix **vI-** (I → it) and **-pu'** (completed): **vIra'pu'**. OVS order gives **ghom vIra'pu'**.
3. Clause two: *We solved the problem.* Object = **Qatlh** (difficulty). Verb = **Qap** (succeed) — but a better idiom is *we overcame*, so use **charghpu'** (conquered) with prefix **wI-** (we → it): **wIcharghpu'**. Gives **Qatlh wIcharghpu'**.
4. Join: **ghom vIra'pu' 'ej Qatlh wIcharghpu'**

Back-translation: *Team I-directed-completed and difficulty we-conquered-completed.*

Notice the back-translation is deliberately literal and slightly awkward. That's correct — it should reveal the Klingon structure, not smooth it into natural English.

---

## 8. pIqaD transliteration

pIqaD is the Klingon writing system. In the Unicode Private Use Area convention, each Latin transcription letter maps to a single codepoint from **U+F8D0** to **U+F8FF**.

Map by **letter**, not by character — the digraphs **ch, gh, ng, tlh** are each *one* pIqaD glyph, not two or three. The apostrophe **'** is also its own glyph.

Preserve spaces between words. Punctuation may be left as-is.

---

## 9. Output requirements

Return strict JSON with exactly four fields:

- **\`english\`** — a strong, concise interview answer. Two to three sentences. Specific and confident, no filler, no "great question." This is the primary output; everything else derives from it.
- **\`klingon\`** — that answer in Klingon, Latin transcription, correct capitalization, OVS order.
- **\`pIqaD\`** — the Klingon text transliterated into pIqaD script.
- **\`backTranslation\`** — a literal, structure-revealing English back-translation of the Klingon.

**Two constraints that matter:**

Keep the Klingon short. Klingon vocabulary is small, and long answers force invention. Translate the *substance* of the English answer, not every word of it — a compressed, accurate rendering beats a complete, fabricated one.

Never invent vocabulary. If you lack a word, paraphrase with words you have. *"I optimized the deployment pipeline"* has no direct Klingon rendering; **mIw vIQaptaHmoH** (*I made the process succeed*) is the honest and correct move.
` as const;

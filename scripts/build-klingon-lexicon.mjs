// Build a grounding lexicon from the canonical Klingon dictionary data.
//
// Fetches the De7vID/klingon-assistant-data dataset (the data behind the
// boQwI' dictionary, Apache-2.0), parses its XML entries, and emits
// data/klingon-lexicon.json with English->Klingon and Klingon->English
// indexes for grounding Klingon generation in attested vocabulary.
//
// Repeatable: `npm run build:lexicon` (or `node scripts/build-klingon-lexicon.mjs`).
// Requires Node 18+ (uses global fetch). No external dependencies.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "De7vID/klingon-assistant-data";
const BRANCH = "master";
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
// Root listing on the default branch (which is BRANCH); a `?ref=` on the root
// contents path 404s, so we rely on the default branch here and pin BRANCH
// only for the raw file fetches below.
const CONTENTS_API = `https://api.github.com/repos/${REPO}/contents`;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_JSON = join(ROOT, "data", "klingon-lexicon.json");
const OUT_NOTICE = join(ROOT, "data", "klingon-lexicon.NOTICE.md");
const OUT_LICENSE = join(ROOT, "data", "klingon-lexicon.LICENSE.txt");

// Base parts of speech whose definitions are word-level glosses worth splitting
// into individual concepts ("discover, find, observe" -> three keys). Sentences
// (sen) and sources (src) are handled differently or skipped.
const SPLITTABLE_POS = new Set([
  "v",
  "n",
  "adv",
  "conj",
  "ques",
  "excl",
  "num",
  "pro",
]);

/** Decode the XML entities that appear in the dataset. */
function decodeEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    // Ampersand last so it doesn't double-decode the entities above.
    .replace(/&amp;/g, "&");
}

/**
 * Replace boQwI' link markup with its plain display text:
 *   {b:sen:nolink}                        -> b
 *   {tlhIngan Hol:n@@tlhIngan:n, Hol:n}   -> tlhIngan Hol
 */
function stripLinks(text) {
  return text
    .replace(/\{([^{}]*)\}/g, (_, inner) => inner.split("@@")[0].split(":")[0])
    .replace(/\s+/g, " ")
    .trim();
}

/** Split a colon-encoded part_of_speech into its base and attribute tags. */
function parsePartOfSpeech(raw) {
  const value = raw.trim();
  const colon = value.indexOf(":");
  const base = (colon === -1 ? value : value.slice(0, colon)).trim();
  const tags =
    colon === -1
      ? []
      : value
          .slice(colon + 1)
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
  // Homophone disambiguation is encoded as a numeric tag (optionally "h"-suffixed).
  const homophone = tags.find((t) => /^\d+h?$/.test(t)) ?? null;
  return { base, tags, homophone };
}

/** Split a gloss on top-level commas/semicolons, ignoring parenthesised text. */
function splitGloss(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if ((ch === "," || ch === ";") && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Normalise an English phrase into a lookup key. */
function normaliseKey(phrase) {
  return phrase.toLowerCase().replace(/\s+/g, " ").trim();
}

/** All English lookup keys a definition should be indexed under. */
function englishKeys(cleanDefinition, base) {
  const keys = new Set();
  const add = (phrase) => {
    const key = normaliseKey(phrase);
    if (key) keys.add(key);
  };
  const withoutParens = (s) => s.replace(/\s*\([^)]*\)\s*/g, " ").trim();

  add(cleanDefinition);
  add(withoutParens(cleanDefinition));

  if (SPLITTABLE_POS.has(base)) {
    for (const part of splitGloss(cleanDefinition)) {
      add(part);
      const bare = withoutParens(part);
      add(bare);
      // Adjectival verbs read "be happy"; also index the bare quality "happy".
      const be = bare.match(/^be\s+(.+)$/i);
      if (be) add(be[1]);
    }
  }
  return [...keys];
}

/** Parse one XML file's <table name="mem"> blocks into raw column maps. */
function parseTables(xml) {
  const rows = [];
  const tableRe = /<table\s+name="mem">([\s\S]*?)<\/table>/g;
  const columnRe = /<column\s+name="([^"]+)">([\s\S]*?)<\/column>/g;
  let table;
  while ((table = tableRe.exec(xml)) !== null) {
    const columns = {};
    let col;
    while ((col = columnRe.exec(table[1])) !== null) {
      columns[col[1]] = decodeEntities(col[2]);
    }
    rows.push(columns);
  }
  return rows;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "kluely-lexicon-builder" },
  });
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  return res.text();
}

async function listMemFiles() {
  const listing = JSON.parse(await fetchText(CONTENTS_API));
  return listing
    .map((item) => item.name)
    .filter((name) => /^mem-\d+-.*\.xml$/.test(name))
    .sort();
}

async function main() {
  console.log(`Fetching file list from ${REPO}@${BRANCH} ...`);
  const files = await listMemFiles();
  console.log(`  ${files.length} data files`);

  console.log("Downloading and parsing entries ...");
  const englishToKlingon = new Map(); // key -> array of E->K senses
  const klingonToEnglish = new Map(); // klingon word -> array of K->E senses

  let entryCount = 0;
  let canonCount = 0;
  let skipped = 0;

  for (const file of files) {
    // "Canon" = came from / approved by Marc Okrand: lives in a main-section
    // file (anything but `extra`/`examples`). Per-entry hyp/extcan tags below
    // further exclude hypothesised and extended-canon words.
    const mainSection = !/extra|examples/.test(file);
    const xml = await fetchText(`${RAW_BASE}/${file}`);
    const rows = parseTables(xml);

    for (const row of rows) {
      const entryName = (row.entry_name ?? "").trim();
      const definitionRaw = (row.definition ?? "").trim();
      const posRaw = (row.part_of_speech ?? "").trim();
      const source = (row.source ?? "").trim();
      const { base, tags, homophone } = parsePartOfSpeech(posRaw);

      // Skip bibliographic source rows, alt-spelling pointers (their
      // "definition" is a Klingon reference, not an English gloss), and blanks.
      if (!entryName || !definitionRaw) {
        skipped++;
        continue;
      }
      if (base === "src" || tags.includes("alt")) {
        skipped++;
        continue;
      }

      const gloss = stripLinks(definitionRaw);
      if (!gloss) {
        skipped++;
        continue;
      }

      const canon =
        mainSection && !tags.includes("hyp") && !tags.includes("extcan");

      entryCount++;
      if (canon) canonCount++;

      // Klingon -> English index.
      const kToE = klingonToEnglish.get(entryName) ?? [];
      kToE.push({
        pos: base,
        tags,
        definition: gloss,
        canon,
        homophone,
        source: source ? stripLinks(source) : null,
      });
      klingonToEnglish.set(entryName, kToE);

      // English -> Klingon index, under every concept the gloss expresses.
      const sense = { klingon: entryName, pos: base, tags, gloss, canon, homophone };
      for (const key of englishKeys(gloss, base)) {
        const bucket = englishToKlingon.get(key) ?? [];
        // De-duplicate identical senses that arrive via multiple keys/rows.
        const dupe = bucket.some(
          (s) => s.klingon === sense.klingon && s.pos === sense.pos && s.gloss === sense.gloss
        );
        if (!dupe) bucket.push(sense);
        englishToKlingon.set(key, bucket);
      }
    }
  }

  // Canon-first ordering so consumers reach for the attested word first.
  const byCanonThenWord = (a, b) => {
    if (a.canon !== b.canon) return a.canon ? -1 : 1;
    return (a.klingon ?? a.definition).localeCompare(b.klingon ?? b.definition);
  };
  const sortedEnglish = {};
  for (const key of [...englishToKlingon.keys()].sort()) {
    sortedEnglish[key] = englishToKlingon.get(key).slice().sort(byCanonThenWord);
  }
  const sortedKlingon = {};
  for (const key of [...klingonToEnglish.keys()].sort()) {
    sortedKlingon[key] = klingonToEnglish.get(key);
  }

  const lexicon = {
    _meta: {
      description:
        "English<->Klingon lookup built from the canonical boQwI' dictionary data, for grounding Klingon generation.",
      source: REPO,
      sourceUrl: `https://github.com/${REPO}`,
      sourceBranch: BRANCH,
      license: "Apache-2.0",
      licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
      copyright:
        "Copyright (C) 2014 De'vID jonpIn (David Yonge-Mallo) and contributors",
      trademark:
        "Klingon, Star Trek, and related marks are trademarks of CBS Studios, Inc.",
      canonDefinition:
        "canon = came from or approved by Marc Okrand: in a main-section file (not `extra`/`examples`) and not tagged `hyp` (hypothesised) or `extcan` (extended canon).",
      generatedBy: "scripts/build-klingon-lexicon.mjs",
      generatedAt: new Date().toISOString(),
      counts: {
        sourceFiles: files.length,
        entries: entryCount,
        canonEntries: canonCount,
        nonCanonEntries: entryCount - canonCount,
        englishKeys: Object.keys(sortedEnglish).length,
        klingonWords: Object.keys(sortedKlingon).length,
        skippedRows: skipped,
      },
    },
    englishToKlingon: sortedEnglish,
    klingonToEnglish: sortedKlingon,
  };

  await mkdir(dirname(OUT_JSON), { recursive: true });
  await writeFile(OUT_JSON, JSON.stringify(lexicon, null, 2) + "\n", "utf8");

  // Attribution artefacts (Apache-2.0 requires retaining the notice + license).
  await writeFile(OUT_NOTICE, NOTICE, "utf8");
  try {
    const license = await fetchText(`${RAW_BASE}/LICENSE`);
    await writeFile(OUT_LICENSE, license, "utf8");
  } catch (err) {
    console.warn(`  (could not fetch upstream LICENSE: ${err.message})`);
  }

  console.log("\nDone.");
  console.log(`  entries:        ${entryCount} (${canonCount} canon, ${entryCount - canonCount} non-canon)`);
  console.log(`  english keys:   ${Object.keys(sortedEnglish).length}`);
  console.log(`  klingon words:  ${Object.keys(sortedKlingon).length}`);
  console.log(`  skipped rows:   ${skipped}`);
  console.log(`  -> ${OUT_JSON}`);
}

const NOTICE = `# Klingon lexicon — data attribution

\`data/klingon-lexicon.json\` is generated by \`scripts/build-klingon-lexicon.mjs\`
from the **klingon-assistant-data** dataset — the Klingon language data behind
the boQwI' dictionary app.

- Source: https://github.com/De7vID/klingon-assistant-data
- Copyright (C) 2014 De'vID jonpIn (David Yonge-Mallo) and contributors
- Licensed under the Apache License, Version 2.0 (see
  \`klingon-lexicon.LICENSE.txt\`): https://www.apache.org/licenses/LICENSE-2.0

Klingon, Star Trek, and related marks are trademarks of CBS Studios, Inc.

## What "canon" means here

An entry is marked \`canon: true\` when it comes from (or was approved by) Marc
Okrand: it appears in a main-section source file (not the \`extra\` or
\`examples\` sections) and is not tagged \`hyp\` (hypothesised) or \`extcan\`
(extended canon, i.e. from a Star Trek novel or other media but not known to be
from Okrand). See the dataset README for the full definition.

Regenerate with \`npm run build:lexicon\`.
`;

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

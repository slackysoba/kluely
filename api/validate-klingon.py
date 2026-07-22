"""Klingon morphology validation — Vercel Python serverless function.

Accepts Klingon text and returns, per word, whether it parses as valid Klingon
morphology, its morpheme breakdown, and its gloss/meaning. Powered by yajwiz.

Endpoint: /api/validate-klingon
  GET  /api/validate-klingon?text=Heghlu'meH+QaQ+jajvam
  POST /api/validate-klingon   body: {"text": "Heghlu'meH QaQ jajvam"}

--- Attribution ------------------------------------------------------------
Morphological analysis by **yajwiz** (Klingon NLP toolkit) by Iikka Hauhio,
licensed under the Apache License 2.0 — https://pypi.org/project/yajwiz/
yajwiz analyses against the **boQwI' dictionary** (De7vID/klingon-assistant-data),
also Apache-2.0. See api/NOTICE.md. Klingon and Star Trek are trademarks of
CBS Studios, Inc.
---------------------------------------------------------------------------
"""

import os

# yajwiz caches the boQwI' dictionary under appdirs.user_data_dir(), which on
# Vercel resolves to a read-only path. Redirect it to the writable /tmp BEFORE
# importing yajwiz — the dictionary is fetched and loaded at import time, so
# this must happen first. On a cold start yajwiz downloads it (~1 MB) into
# /tmp; warm invocations reuse the cached copy.
os.environ["XDG_DATA_HOME"] = "/tmp/yajwiz-home"
os.environ.setdefault("HOME", "/tmp/yajwiz-home")

import json  # noqa: E402  (import after the env redirect above)
from http.server import BaseHTTPRequestHandler  # noqa: E402
from urllib.parse import parse_qs, urlparse  # noqa: E402

import yajwiz  # noqa: E402

# Loaded once per instance (import already triggered the load/download).
DICTIONARY = yajwiz.load_dictionary()

MAX_TEXT_LENGTH = 2_000
MAX_WORDS = 120
MAX_ANALYSES_PER_WORD = 8

ATTRIBUTION = (
    "Morphology by yajwiz (Iikka Hauhio, Apache-2.0), analysing the boQwI' "
    "dictionary (De7vID/klingon-assistant-data, Apache-2.0)."
)


def _pick_gloss(definition):
    """The English gloss for a boQwI' entry, falling back to any locale."""
    if not definition:
        return None
    return definition.get("en") or next(iter(definition.values()), None)


def _morpheme(part_id):
    """Map a boQwI' morpheme id to its surface form, POS, and gloss."""
    entry = DICTIONARY.entries.get(part_id)
    if entry is not None:
        return {
            "id": part_id,
            "text": entry.name,
            "pos": entry.part_of_speech,
            "gloss": _pick_gloss(entry.definition),
        }
    # Prefixes and grammatical markers aren't dictionary headwords.
    return {"id": part_id, "text": part_id, "pos": None, "gloss": None}


def _describe_analysis(analysis):
    lemma_entry = DICTIONARY.entries.get(analysis.get("BOQWIZ_ID", ""))
    suffixes = analysis.get("SUFFIX") or {}
    return {
        "lemma": analysis.get("LEMMA"),
        "pos": analysis.get("POS"),
        "xpos": analysis.get("XPOS"),
        "boqwizPos": analysis.get("BOQWIZ_POS"),
        # Present (with a reason) only when yajwiz flags the parse as invalid.
        "ungrammatical": analysis.get("UNGRAMMATICAL"),
        "gloss": _pick_gloss(lemma_entry.definition) if lemma_entry else None,
        "prefix": analysis.get("PREFIX"),
        "suffixes": list(suffixes.values()),
        "morphemes": [_morpheme(p) for p in analysis.get("PARTS", [])],
    }


def _analyze_word(word):
    try:
        analyses = yajwiz.analyze(word)
    except Exception:  # pragma: no cover - defensive; never fail a whole request
        analyses = []
    described = [_describe_analysis(a) for a in analyses[:MAX_ANALYSES_PER_WORD]]
    parses = len(analyses) > 0
    # "valid" = at least one parse that yajwiz did not flag as ungrammatical.
    valid = any(a.get("UNGRAMMATICAL") is None for a in analyses)
    return {
        "word": word,
        "valid": valid,
        "parses": parses,
        "analyses": described,
    }


def analyze_text(text):
    words = []
    for token in yajwiz.tokenize(text):
        if token.token_type == "WORD":
            words.append(_analyze_word(token.text))
            if len(words) >= MAX_WORDS:
                break
    return {
        "text": text,
        "dictionaryVersion": DICTIONARY.version,
        "wordCount": len(words),
        "validWordCount": sum(1 for w in words if w["valid"]),
        "words": words,
        "attribution": ATTRIBUTION,
    }


def _extract_text_from_body(raw):
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("body must be a JSON object")
    text = data.get("text")
    if not isinstance(text, str):
        raise ValueError("missing string field 'text'")
    return text


class handler(BaseHTTPRequestHandler):
    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # Allow calls from the browser / the app frontend.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def _handle(self, text):
        text = (text or "").strip()
        if not text:
            self._send_json(400, {"error": "Provide Klingon text via ?text= or JSON {\"text\": ...}."})
            return
        if len(text) > MAX_TEXT_LENGTH:
            self._send_json(413, {"error": f"Text too long (max {MAX_TEXT_LENGTH} characters)."})
            return
        try:
            self._send_json(200, analyze_text(text))
        except Exception:
            # Never leak internals to the client.
            self._send_json(500, {"error": "Failed to analyze text."})

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        params = parse_qs(urlparse(self.path).query)
        text = params.get("text", [""])[0]
        self._handle(text)

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            length = 0
        if length <= 0 or length > MAX_TEXT_LENGTH * 8:
            self._send_json(400, {"error": "Request body must be JSON: {\"text\": string}."})
            return
        raw = self.rfile.read(length)
        try:
            text = _extract_text_from_body(raw)
        except (ValueError, json.JSONDecodeError):
            self._send_json(400, {"error": "Request body must be JSON: {\"text\": string}."})
            return
        self._handle(text)

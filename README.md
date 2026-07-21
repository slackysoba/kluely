<img src="app/icon.svg" width="72" alt="Kluely logo" />

# Kluely

Real-time interview answers, in Klingon.

## Premise

A parody of Cluely. You speak the interviewer's question aloud; Kluely
transcribes it live and returns a strong, concise answer — rendered in
grammatically disciplined tlhIngan Hol, with pIqaD script and a literal
back-translation. Interview coaching for Klingons. It is exactly as
useful as it sounds.

![Demo](docs/demo.gif)

<!-- TODO: replace with recorded demo -->

## How it works

Five stages, two external services:

```
┌────────────┐  Float32 @ native rate   ┌─────────────────────┐
│ Microphone │ ───────────────────────► │ AudioWorklet        │
└────────────┘                          │ downmix → 16 kHz    │
                                        │ → PCM16, 50 ms      │
                                        └──────────┬──────────┘
                                                   │ ArrayBuffer chunks
                                                   ▼
┌─────────────────────┐   binary frames   ┌─────────────────────┐
│ AssemblyAI          │ ◄──────────────── │ WebSocket client    │
│ Universal-Streaming │ ────────────────► │ (temp token auth)   │
│ v3 WebSocket        │   Turn messages   └──────────┬──────────┘
└─────────────────────┘                              │ end_of_turn: true
                                                     ▼
┌─────────────────────┐   structured JSON  ┌─────────────────────┐
│ Gemini Flash-Lite   │ ◄───────────────── │ POST /api/answer    │
│ + grammar primer    │ ─────────────────► │ (server route)      │
└─────────────────────┘  english / klingon └──────────┬──────────┘
                         / pIqaD / literal            ▼
                                            ┌─────────────────────┐
                                            │ UI: answer card,    │
                                            │ pIqaD webfont,      │
                                            │ live latency        │
                                            └─────────────────────┘
```

1. **Capture** — an `AudioWorkletProcessor` receives Float32 audio at the
   browser's native sample rate, downmixes to mono, resamples to 16 kHz
   with linear interpolation (continuous across render quanta), converts
   to 16-bit PCM, and posts 50 ms chunks (800 samples) to the main thread
   as transferred `ArrayBuffer`s.
2. **Transcribe** — chunks stream over a WebSocket to AssemblyAI's v3
   Universal-Streaming endpoint, authenticated with a short-lived token.
3. **Detect** — the client separates partial transcripts from finalized
   turns (`end_of_turn: true`). Partials paint the live transcript;
   finals trigger generation.
4. **Generate** — the finalized question goes to a server route that
   calls Gemini Flash-Lite in structured-output mode, with a Klingon
   grammar primer in the system instruction and a response schema pinning
   exactly four string fields.
5. **Render** — the answer card shows the Klingon, its pIqaD
   transliteration (CSUR Private Use Area, rendered with a bundled OFL
   font), the literal back-translation, and the polished English.

## Why temporary tokens

Browsers can't set headers on WebSocket connections, so the streaming
connection must authenticate via query parameter. Putting the permanent
API key there would ship it to every visitor. Instead, a server route
exchanges the key for a single-use token with a 60-second redemption
window and a capped session length; the worst-case leak is one short
streaming session:

```ts
// app/api/token/route.ts
const url = new URL("https://streaming.assemblyai.com/v3/token");
url.searchParams.set("expires_in_seconds", "60");
url.searchParams.set("max_session_duration_seconds", "600");

const response = await fetch(url, {
  headers: { Authorization: apiKey }, // key stays server-side
});
const { token } = await response.json();
return NextResponse.json({ token }); // browser gets only this
```

The Gemini key follows the same rule by construction: it is only read
inside a server route.

## Technical notes

**AudioWorklet, not ScriptProcessorNode.** `ScriptProcessorNode` is
deprecated: it processes audio on the main thread, so a busy UI causes
dropped frames and glitchy capture. The worklet runs on the audio
rendering thread, keeps the resampler's fractional read position and one
sample of history across 128-frame render quanta (no seams at block
boundaries), and hands buffers to the main thread zero-copy via
transfer.

**Finals versus partials.** Universal-Streaming emits many `Turn`
messages per utterance; only the one with `end_of_turn: true` is stable,
formatted text. Partials are rendered but never trigger generation —
firing an LLM call per partial would send malformed fragments and burn
quota. Generation is therefore debounced on turn finalization, and if a
new final lands while a request is in flight, the stale request is
cancelled via `AbortController` rather than letting two responses race
for the UI.

**Session lifecycle.** Streaming is billed on wall-clock connection
time, not audio sent. An abandoned socket keeps billing until the server
force-closes it after three hours. The client therefore treats
termination as a protocol, not a cleanup afterthought: `stop()` sends
`{"type": "Terminate"}` and waits for the server's `Termination` message
before closing (closing early silently discards the last transcript), a
`beforeunload` handler terminates on page exit, a `visibilitychange`
timer terminates after 30 s of hidden tab, and every error path closes
the socket.

**Latency.** The status bar shows a live measurement: the interval
between sending the final audio chunk of a turn and receiving that
turn's finalized transcript. Expect low hundreds of milliseconds on a
typical connection, in line with AssemblyAI's published figures for
immutable finalization; the Gemini round trip adds roughly one to two
seconds on top before the answer card renders. Treat the in-app number
as the honest one — it includes your actual network.

## Limitations and tradeoffs

- **The Klingon is model-generated, not verified.** Generation is
  constrained by a grammar primer (OVS order, prefix/suffix tables, a
  no-invented-vocabulary rule) and a strict response schema, but no
  fluent speaker has reviewed the output. Assume errors a Klingon
  Language Institute member would find embarrassing.
- **Live/meeting capture is not really here.** The Meeting mode toggle
  is a disabled stub. Practice mode uses `getUserMedia` (your
  microphone). A future meeting mode built on `getDisplayMedia` would be
  Chromium-only and captures a browser tab's audio — not Zoom, not any
  native desktop app.
- **No speaker diarization in the live stream.** Everyone within
  microphone range is one undifferentiated speaker; the interviewer and
  the candidate are the same voice as far as the pipeline is concerned.
- **One answer at a time.** A new finalized question cancels and
  replaces the in-flight answer; there is no history within a session.
- **The latency figure is an approximation.** It timestamps the most
  recent chunk sent before the final arrived; it cannot see inside the
  provider's pipeline.

## Local setup

Requires Node 18+ and a Chromium- or Gecko-based browser with
microphone access.

```sh
git clone <repo-url> && cd kluely-app
npm install
cp .env.example .env.local   # then fill in both keys
npm run dev
```

- `ASSEMBLYAI_API_KEY` — from the AssemblyAI dashboard.
- `GEMINI_API_KEY` — from Google AI Studio.

Open `http://localhost:3000` (localhost counts as a secure context, so
`getUserMedia` works without HTTPS), press the button, and ask a
question out loud. Production deployments need HTTPS and should set
`NEXT_PUBLIC_SITE_URL` for correct Open Graph URLs.

## Credits

- [AssemblyAI](https://www.assemblyai.com/) — Universal-Streaming v3
  speech-to-text.
- [Google Gemini](https://ai.google.dev/) — answer generation
  (Flash-Lite, structured output).
- [pIqaD qolqoS](https://github.com/dadap/pIqaD-fonts) by Daniel Dadap —
  the pIqaD typeface, SIL Open Font License 1.1 (see
  `public/fonts/LICENSE`).
- The Klingon language was created by Marc Okrand. "Klingon" is a
  trademark of CBS Studios. This is a fan-made parody with no
  affiliation to CBS, Paramount, or Cluely.

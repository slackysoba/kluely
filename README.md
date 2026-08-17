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
│ Mic or tab │ ───────────────────────► │ AudioWorklet        │
│ audio      │                          │ downmix → 16 kHz    │
└────────────┘                          │ → PCM16, 50 ms      │
                                        └──────────┬──────────┘
                                                   │ ArrayBuffer chunks
                                                   ▼
┌─────────────────────┐   audio frames    ┌─────────────────────┐
│ STT provider:       │ ◄──────────────── │ WebSocket client    │
│ Inworld (default)   │ ────────────────► │ (temp token auth)   │
│ or AssemblyAI       │  transcript msgs  └──────────┬──────────┘
└─────────────────────┘                              │ end of turn
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

1. **Capture** — audio comes from the microphone (Practice mode,
   `getUserMedia`) or a shared browser tab (Live mode,
   `getDisplayMedia`; the video track is requested because Chrome
   requires it, then immediately discarded). Either way an
   `AudioWorkletProcessor` receives Float32 audio at the source rate
   (tab audio is typically 48 kHz stereo), downmixes to mono, resamples
   to 16 kHz with linear interpolation (continuous across render
   quanta), converts to 16-bit PCM, and posts 50 ms chunks (800 samples)
   to the main thread as transferred `ArrayBuffer`s.
2. **Transcribe** — chunks stream over a WebSocket to a real-time
   speech-to-text provider, authenticated with a short-lived token.
   Inworld Realtime STT is the default; a toggle on the home screen
   switches to AssemblyAI Universal-Streaming. Both clients implement one
   `TranscriptionProvider` interface (`lib/transcription-provider.ts`), so
   the choice is just which class the pipeline instantiates — nothing
   downstream branches on it.
3. **Detect** — the client separates partial transcripts from finalized
   turns (each provider's automatic turn detection). Partials paint the
   live transcript; finals trigger generation.
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

Inworld follows the same pattern: `app/api/inworld-token` mints a
short-lived Inworld session token server-side (signing a per-request
`IW1-HMAC-SHA256` header with the key/secret to exchange for the token),
and the browser passes it on the STT socket the same way. The Gemini key
follows the rule by construction too: it is only read inside a server
route.

## Technical notes

**AudioWorklet, not ScriptProcessorNode.** `ScriptProcessorNode` is
deprecated: it processes audio on the main thread, so a busy UI causes
dropped frames and glitchy capture. The worklet runs on the audio
rendering thread, keeps the resampler's fractional read position and one
sample of history across 128-frame render quanta (no seams at block
boundaries), and hands buffers to the main thread zero-copy via
transfer.

**Finals versus partials.** Streaming STT emits many partial transcripts
per utterance; only the finalized turn (the provider's end-of-turn
signal) is stable text. Partials are rendered but never trigger generation —
firing an LLM call per partial would send malformed fragments and burn
quota. Generation is therefore debounced on turn finalization, and if a
new final lands while a request is in flight, the stale request is
cancelled via `AbortController` rather than letting two responses race
for the UI.

**Session lifecycle.** Streaming is billed on wall-clock connection
time, not audio sent. An abandoned socket keeps billing until the server
force-closes it after three hours. The client therefore treats
termination as a protocol, not a cleanup afterthought: `stop()` signals
the provider to finish (AssemblyAI `{"type": "Terminate"}`, Inworld
`{"closeStream": {}}`) and waits for the server to flush the last
transcript before closing (closing early silently discards it), a
`beforeunload` handler terminates on page exit, a `visibilitychange`
timer terminates after 30 s of hidden tab, and every error path closes
the socket. Both provider clients apply this identical discipline.

**Latency.** The status bar shows a live measurement: the interval
between sending the final audio chunk of a turn and receiving that
turn's finalized transcript. Both providers measure it the same way, so
the readout is comparable across the toggle; the Gemini round trip adds
roughly one to two seconds on top before the answer card renders. Treat
the in-app number as the honest one — it includes your actual network.

## Notetaker Mode (Recall.ai)

A third mode alongside Practice and Live. Instead of capturing your mic
or a browser tab, it sends a [Recall.ai](https://recall.ai) bot into a
Zoom call you're already in, streams the meeting transcript back, and
lets you copy or download it. It's designed for Vercel serverless from
the ground up.

**Flow.** You paste a Zoom link → `POST /api/recall/create-bot` validates
it, calls Recall's Create Bot (v1.11), and stores a session in Redis
keyed by the returned `botId` → the `botId` is saved in `localStorage`
and the client polls `GET /api/recall/session/[botId]` every 2s → Recall
POSTs transcript and status events to `/api/recall/webhook`, which
appends lines and updates status in Redis. "End & download" builds the
`.txt` client-side, then calls `POST /api/recall/leave`.

**Serverless-safe by design.**

- **State lives in Redis, not memory.** Serverless invocations share no
  memory, so transcript state is kept in a Vercel Redis store over
  `REDIS_URL` using `ioredis` (the RESP protocol, *not* the `@vercel/kv`
  REST SDK). A single connection is cached on `globalThis` and reused
  across warm invocations.
- **Polling, not SSE.** The client polls a plain `GET` every 2s. No
  server-sent events or long-lived connections, which don't survive
  serverless function limits reliably.
- **No auth (yet).** The client only ever knows its own `botId` and can
  only fetch that one session. There is deliberately **no** endpoint that
  lists sessions — that would leak transcripts between visitors. This is
  obscurity, not security; every route carries a `SECURITY / TODO` noting
  that real auth (binding sessions to an authenticated user) is the fix.
- **Bot media is bundled, not fetched.** The bot shows
  `assets/notetaker/logo.jpg` as its camera and plays
  `assets/notetaker/intro.mp3` on join, base64-encoded into the Create
  Bot request. Those files are force-included into the create-bot
  serverless bundle via `outputFileTracingIncludes` in `next.config.ts`
  (the same mechanism the answer route uses for the Klingon lexicon), so
  they're readable at runtime on Vercel.

**Two webhook shapes land at one URL.** `recording_config.realtime_endpoints`
delivers `transcript.data` (utterances). But in the **v1.11 API, bot
status-change events cannot be delivered via `realtime_endpoints`** —
they come from the **account-level webhook you configure in the Recall
dashboard** (delivered via Svix). The `/api/recall/webhook` route handles
both payload shapes, but the "in waiting room" / "recording" status
indicator only lights up once you point the dashboard webhook at the
same URL:

> **Recall dashboard → Webhooks → add endpoint →**
> `https://kluelyapp.com/api/recall/webhook`, subscribed to the
> `bot.*` status-change events.

**Video and audio output use different shapes — this is real, not a
typo.** Confirmed against a live 400: `automatic_video_output` puts
`kind` / `b64_data` **directly** on `in_call_recording` /
`in_call_not_recording` (no `data` wrapper), while
`automatic_audio_output` **nests** them under `data`:

```jsonc
"automatic_video_output": { "in_call_recording": { "kind": "jpeg", "b64_data": "…" } },
"automatic_audio_output": { "in_call_recording": { "data": { "kind": "mp3", "b64_data": "…" } } }
```

If Create Bot returns a 400, the create-bot route surfaces **Recall's
full error body verbatim** in the response (`recallStatus` +
`recallBody`) and logs it — read that to see exactly which field it
rejected. Setting `DEBUG_RECALL=1` additionally logs every raw webhook
payload to the Vercel logs.

### Environment (already set in Vercel)

Server-side only — `RECALL_API_KEY` must never reach the client.

- `RECALL_API_KEY` — sent as the raw `Authorization` header (no `Bearer`).
- `RECALL_REGION` — e.g. `us-west-2`, forms the API base URL
  `https://<region>.recall.ai`.
- `PUBLIC_BASE_URL` — public origin (e.g. `https://kluelyapp.com`), used
  to build the webhook callback URL.
- `REDIS_URL` — the Vercel Redis connection string (`ioredis`-compatible).
- `DEBUG_RECALL` — set to `1` to log raw webhook payloads; unset otherwise.

### Testing against the deployed site

This runs in production on Vercel — there is no local tunnel, and
webhooks must reach a public URL, so test against the live deploy:

1. **Confirm env + webhook.** In Vercel, verify the five vars above are
   set. In the Recall dashboard, confirm a webhook endpoint points at
   `https://kluelyapp.com/api/recall/webhook` for the `bot.*` events.
   (Optionally set `DEBUG_RECALL=1` while testing, then remove it.)
2. **Start a Zoom call yourself** and copy its join link
   (`https://…zoom.us/j/…`). Enable the waiting room if you want to see
   that status.
3. **Open** `https://kluelyapp.com`, choose **Notetaker**, paste the
   link, and click **Join meeting**.
4. **Watch the status.** It should move `Joining…` → **Waiting to be
   admitted** (if a waiting room is on) → admit "Kluely Notetaker" from
   Zoom → **Transcribing**. The bot shows the Kluely logo and plays the
   intro clip on join.
5. **Speak.** Lines should appear in the feed within a couple of seconds
   (it polls every 2s). If nothing appears but status is "Transcribing",
   check `DEBUG_RECALL` logs for the raw `transcript.data` shape.
6. **Reload the page** mid-call — the session resumes from `localStorage`
   and keeps polling.
7. **Copy transcript** (clipboard) and **End & download transcript**
   (downloads a `.txt`, then the bot leaves the call). Left alone, the
   bot leaves on its own via `automatic_leave` (300s waiting-room
   timeout).
8. **On a 400 from step 3**, read the `recallBody` in the error shown in
   the UI / Vercel logs — see the `automatic_video_output` note above.

## Limitations and tradeoffs

- **The Klingon is model-generated, not verified.** Generation is
  constrained by a grammar primer (OVS order, prefix/suffix tables, a
  no-invented-vocabulary rule) and a strict response schema, but no
  fluent speaker has reviewed the output. Assume errors a Klingon
  Language Institute member would find embarrassing.
- **Live mode captures a browser tab, nothing else.** It is built on
  `getDisplayMedia`, which only carries tab audio on Chromium browsers,
  and only when the user ticks "Also share tab audio" in the picker. It
  cannot hear Zoom, Teams, or any native desktop app — browser-tab
  meetings only.
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
cp .env.example .env.local   # then fill in the keys
npm run dev
```

- `INWORLD_API_KEY` — the Base64 key from the Inworld Studio API Keys
  panel (the default transcription provider).
- `ASSEMBLYAI_API_KEY` — from the AssemblyAI dashboard (used when the
  provider toggle is set to AssemblyAI).
- `GEMINI_API_KEY` — from Google AI Studio.
- `RECALL_API_KEY`, `RECALL_REGION`, `PUBLIC_BASE_URL`, `REDIS_URL` (and
  optional `DEBUG_RECALL`) — for Notetaker Mode; see
  [Notetaker Mode](#notetaker-mode-recallai). Note that Notetaker relies
  on public webhooks, so it can't be exercised end-to-end from
  `localhost` — test it against the deployed site.

Open `http://localhost:3000` (localhost counts as a secure context, so
`getUserMedia` works without HTTPS), press the button, and ask a
question out loud. Production deployments need HTTPS and should set
`NEXT_PUBLIC_SITE_URL` for correct Open Graph URLs.

## Credits

- [Inworld](https://inworld.ai/) — Realtime speech-to-text (default
  provider).
- [AssemblyAI](https://www.assemblyai.com/) — Universal-Streaming v3
  speech-to-text (alternate provider).
- [Google Gemini](https://ai.google.dev/) — answer generation
  (Flash-Lite, structured output).
- [pIqaD qolqoS](https://github.com/dadap/pIqaD-fonts) by Daniel Dadap —
  the pIqaD typeface, SIL Open Font License 1.1 (see
  `public/fonts/LICENSE`).
- The Klingon language was created by Marc Okrand. "Klingon" is a
  trademark of CBS Studios. This is a fan-made parody with no
  affiliation to CBS, Paramount, or Cluely.

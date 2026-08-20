// lib/elevenlabs-stream.ts
//
// One live ElevenLabs Scribe v2 Realtime STT session, implementing the shared
// TranscriptionProvider contract so it's a drop-in alternative to
// AssemblyAIStream / InworldStream. The browser fetches a short-lived,
// single-use ElevenLabs token from /api/elevenlabs-token, then connects
// straight to ElevenLabs' STT WebSocket — no relay — passing the token (and
// all session config) in the query string.
//
// Wire protocol (`speech-to-text/realtime`):
//   → audio:  {"message_type":"input_audio_chunk","audio_base_64":"<base64>"}
//   ← events: {"message_type":"session_started", session_id, ...}
//             {"message_type":"partial_transcript", text, ...}
//             {"message_type":"final_transcript", text, ...}
//             {"message_type":"committed_transcript", ...}
//             {"message_type":"final_transcript_with_timestamps", ...}
//             {"message_type":"committed_transcript_with_timestamps", ...}
//             {"message_type":"<error-name>", ...}  (see handleMessage)
//
// committed_transcript drives onFinalTranscript. This reverses an earlier
// assumption that final_transcript — arriving ahead of the ~1.5s VAD silence
// window — was the immutable signal to use, on the theory that waiting for
// the commit would needlessly add that latency to the Gemini pipeline. In
// practice, under commit_strategy=vad, final_transcript never arrives at all:
// confirmed both by a live wire capture (only session_started/partial/
// committed ever showed up) and by ElevenLabs' own SDK, whose Scribe realtime
// event list has no final_transcript variant — only session_started,
// partial_transcript, committed_transcript, and the timestamped forms. So the
// original design silently dropped every finalized turn. A working answer
// ~1.5s later beats a pipeline that never fires. final_transcript is still
// wired below (harmless if ElevenLabs ever does emit it, e.g. in some other
// commit-strategy configuration), guarded so it can't double-fire
// onFinalTranscript for the same turn if committed_transcript also arrives.
//
// Error events arrive as a message immediately before the server closes the
// socket, so they're handled in onmessage; handleClose suppresses its own
// "closed unexpectedly" report once an error message has already surfaced
// one, to avoid reporting the same failure twice.
//
// Latency metrics, confirmed from a live committed_transcript_with_timestamps
// payload (do not re-derive): word timing lives in a `words` array of
// `{ text, start, end, type, ... }`, where `start`/`end` are seconds elapsed
// since session start (not ms, not utterance-relative), and `type` is either
// "word" or "spacing" — spacing entries are filtered out before use. Like the
// committed-vs-final text signal, timestamps only ever arrive on
// committed_transcript_with_timestamps; final_transcript_with_timestamps
// doesn't fire under commit_strategy=vad, same root cause as above.
//
// Unlike Inworld, which streams incrementally-growing word arrays on every
// partial (so each word's individual appearance latency is measurable),
// ElevenLabs delivers the whole utterance's word timing in one batch, once,
// at commit time — every word in it became visible to us at the same
// instant. So there's no way to measure "how fast did word N appear" per
// word; both word-emission and turn-detection latency below are computed the
// same way, from the last word's `end` to the receipt of that one message.
// They'll report near-identical numbers for this provider — an honest
// reflection of what the wire protocol actually exposes, not a bug.

import type {
  SessionState,
  TranscriptionCallbacks,
  TranscriptionProvider,
} from "./transcription-provider";
import { SessionCapacityError } from "./transcription-provider";

export { SessionCapacityError };
export type { SessionState };

const TOKEN_ENDPOINT = "/api/elevenlabs-token";
const STT_ENDPOINT = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const MODEL_ID = "scribe_v2_realtime";
const AUDIO_FORMAT = "pcm_16000";
const COMMIT_STRATEGY = "vad";
const VAD_THRESHOLD = 0.5;
const VAD_SILENCE_THRESHOLD_SECS = 1.5;
const MIN_SPEECH_DURATION_MS = 100;
const MIN_SILENCE_DURATION_MS = 100;
const SAMPLE_RATE = 16000;
// Do NOT add filter_background_audio — it's incompatible with
// include_timestamps and the socket will reject the connection.

// Mirror the other clients' cleanup discipline: streaming is billed on
// connection time, so every exit path must close the socket.
const HIDDEN_TAB_TERMINATE_MS = 30_000;
const OPEN_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 5_000;

// Latency measurement — kept identical to lib/inworld-stream.ts so the two
// providers feed the same metrics with the same semantics.
const BYTES_PER_SAMPLE = 2; // 16-bit mono PCM ⇒ 2 bytes per sample.
const LATENCY_WINDOW = 50; // rolling window of per-word latency samples.
const MAX_PLAUSIBLE_LATENCY_MS = 5_000; // above this is a stale anchor, not real.
const MAX_PLAUSIBLE_TURN_MS = 10_000; // turn detection includes the endpoint wait.

// Error message_types that mean the account/session is out of capacity, as
// opposed to a malformed request.
const CAPACITY_ERROR_TYPES = new Set([
  "quota_exceeded",
  "rate_limited",
  "queue_overflow",
  "resource_exhausted",
  "session_time_limit_exceeded",
]);

// Error message_types surfaced verbatim via onError.
const REQUEST_ERROR_TYPES = new Set([
  "auth_error",
  "invalid_request",
  "input_error",
  "chunk_size_exceeded",
  "unaccepted_terms",
  "insufficient_audio_activity",
]);

// The ElevenLabs client speaks the shared provider callback contract; the
// alias keeps call sites specific to this client readable.
export type ElevenLabsStreamCallbacks = TranscriptionCallbacks;

// TEMPORARY diagnostic: dumps every raw server message. Originally added for
// the latency-metrics investigation (confirming the *_with_timestamps
// words-array field names/units and arrival order), now also covering the
// live bug where finalized transcripts don't reach onFinalTranscript —
// message.text may not be the right field/shape for final_transcript even
// though it demonstrably is for partial_transcript (that's what renders
// on-screen while speaking). Don't guess the field name; read it from here.
// Gated on NEXT_PUBLIC_ (not the server-side DEBUG_ELEVENLABS in
// lib/elevenlabs-auth.ts) because this file runs in the browser, where a bare
// `process.env.DEBUG_ELEVENLABS` would never be inlined and the gate would
// silently never fire. Remove this block once the shapes are confirmed and
// final_transcript handling + the latency calculation are both fixed.
const DEBUG_ELEVENLABS =
  process.env.NEXT_PUBLIC_DEBUG_ELEVENLABS === "1";

interface ElevenLabsWord {
  text: string;
  /** Seconds elapsed since session start (not ms, not utterance-relative). */
  start: number;
  /** Seconds elapsed since session start. */
  end: number;
  /** "word" for actual words; "spacing" (and possibly others) for gaps. */
  type: string;
}

interface ElevenLabsServerMessage {
  message_type: string;
  text?: string;
  session_id?: string;
  /** Present only on final_transcript_with_timestamps / committed_transcript_with_timestamps. */
  words?: ElevenLabsWord[];
}

/** Rounded median (p50) of a sample window, or null when it's empty. */
function median(samples: number[]): number | null {
  const n = samples.length;
  if (n === 0) {
    return null;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  const value = n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return Math.round(value);
}

/** Encodes raw PCM bytes as base64 for the `audio_base_64` field. */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // Chunk the String.fromCharCode calls so a large buffer can't blow the
  // argument-count limit / call stack.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function parseServerMessage(raw: string): ElevenLabsServerMessage | null {
  try {
    const data: unknown = JSON.parse(raw);
    if (
      typeof data === "object" &&
      data !== null &&
      typeof (data as { message_type?: unknown }).message_type === "string"
    ) {
      return data as ElevenLabsServerMessage;
    }
  } catch {
    // Malformed frame; ignore.
  }
  return null;
}

/**
 * Manages one ElevenLabs Scribe v2 Realtime STT streaming session.
 *
 * ```ts
 * const stream = new ElevenLabsStream({
 *   onPartialTranscript: (r) => console.log("partial:", r.transcript),
 *   onFinalTranscript: (r) => console.log("final:", r.transcript),
 * });
 * await stream.start();
 * capture.start((chunk) => stream.sendAudio(chunk));
 * // ...
 * await stream.stop();
 * ```
 */
export class ElevenLabsStream implements TranscriptionProvider {
  private readonly callbacks: TranscriptionCallbacks;
  private ws: WebSocket | null = null;
  private state: SessionState = "idle";
  private sessionId: string | null = null;
  private sessionEnded = false;
  private errorAlreadyReported = false;
  // Guards against firing onFinalTranscript twice for the same turn if both
  // final_transcript and committed_transcript arrive for it. Reset whenever a
  // new partial_transcript comes in, since that means a new turn has started.
  private turnFinalized = false;
  private pendingOpen: {
    resolve: () => void;
    reject: (err: Error) => void;
  } | null = null;
  private onClosed: (() => void) | null = null;
  private hiddenTimer: number | null = null;
  private listenersAttached = false;
  // Latency measurement: anchor audio-stream time 0 to the wall clock, then
  // for the final word in each commit compare (message received) − (audio
  // sent) and report a rolling median — see the header comment for why this
  // provider's word-emission and turn-detection metrics share one formula.
  private audioClockBase: number | null = null;
  private latencySamples: number[] = [];
  private turnLatencySamples: number[] = [];

  constructor(callbacks: TranscriptionCallbacks = {}) {
    this.callbacks = callbacks;
  }

  get sessionState(): SessionState {
    return this.state;
  }

  get id(): string | null {
    return this.sessionId;
  }

  /** Rolling median (p50) word-emission latency in ms, or null before any word. */
  get wordEmissionP50Ms(): number | null {
    return median(this.latencySamples);
  }

  /** Rolling median (p50) turn-detection latency in ms, or null before any turn. */
  get turnDetectionP50Ms(): number | null {
    return median(this.turnLatencySamples);
  }

  /** Fetches a fresh single-use token, opens the socket, and resolves once the session has begun. */
  async start(): Promise<void> {
    if (this.state !== "idle" && this.state !== "closed") {
      throw new Error(`Cannot start a session in state "${this.state}"`);
    }
    this.state = "connecting";
    this.sessionId = null;
    this.sessionEnded = false;
    this.turnFinalized = false;
    this.errorAlreadyReported = false;
    this.audioClockBase = null;
    this.latencySamples = [];
    this.turnLatencySamples = [];

    // The token is single-use (consumed on first use) and expires in 15
    // minutes, so it's minted here and never cached across sessions.
    let token: string;
    try {
      const res = await fetch(TOKEN_ENDPOINT);
      if (res.status === 429) {
        throw new SessionCapacityError();
      }
      if (!res.ok) {
        throw new Error(`Token endpoint returned ${res.status}`);
      }
      const body = (await res.json()) as { token?: string };
      if (!body.token) {
        throw new Error("Token endpoint response missing token");
      }
      token = body.token;
    } catch (err) {
      this.state = "closed";
      throw err instanceof Error ? err : new Error(String(err));
    }

    const params = new URLSearchParams({
      model_id: MODEL_ID,
      audio_format: AUDIO_FORMAT,
      commit_strategy: COMMIT_STRATEGY,
      include_timestamps: "true",
      vad_threshold: String(VAD_THRESHOLD),
      vad_silence_threshold_secs: String(VAD_SILENCE_THRESHOLD_SECS),
      min_speech_duration_ms: String(MIN_SPEECH_DURATION_MS),
      min_silence_duration_ms: String(MIN_SILENCE_DURATION_MS),
      token,
    });
    const url = `${STT_ENDPOINT}?${params.toString()}`;

    await new Promise<void>((resolve, reject) => {
      const openTimeout = window.setTimeout(() => {
        this.failPendingOpen(
          new Error("Timed out opening ElevenLabs STT session")
        );
      }, OPEN_TIMEOUT_MS);

      this.pendingOpen = {
        resolve: () => {
          window.clearTimeout(openTimeout);
          resolve();
        },
        reject: (err: Error) => {
          window.clearTimeout(openTimeout);
          reject(err);
        },
      };

      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      // All session config travels in the query string, so there's no
      // config frame to send on open — wait for session_started instead.
      ws.onmessage = (event: MessageEvent) => this.handleMessage(event);
      ws.onclose = (event: CloseEvent) => this.handleClose(event);
    });

    this.attachPageLifecycleHandlers();
  }

  /** Sends one chunk of 16kHz mono 16-bit PCM audio. Drops it if not connected. */
  sendAudio(chunk: ArrayBuffer): void {
    if (
      this.state !== "open" ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    this.ws.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: arrayBufferToBase64(chunk),
      })
    );
    // Anchor stream time 0 to the wall clock on the first chunk, so a word's
    // `end` (seconds since session start) can be mapped back to the moment
    // its audio was sent.
    if (this.audioClockBase === null) {
      const chunkMs =
        (chunk.byteLength / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000;
      this.audioClockBase = performance.now() - chunkMs;
    }
  }

  /**
   * Ends the session: ElevenLabs' realtime protocol has no documented client
   * "end stream" frame (commit_strategy=vad finalizes turns server-side), so
   * ending a session is just closing the socket. Waits for the server's
   * close rather than tearing down synchronously, so anything already in
   * flight is delivered first. Safe to call multiple times.
   */
  async stop(): Promise<void> {
    this.detachPageLifecycleHandlers();
    this.clearHiddenTimer();

    const ws = this.ws;
    if (!ws || this.state === "closed" || this.state === "idle") {
      this.state = "closed";
      return;
    }
    if (this.state === "terminating") {
      return;
    }

    this.state = "terminating";
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => {
        this.onClosed = null;
        resolve();
      }, CLOSE_TIMEOUT_MS);
      this.onClosed = () => {
        window.clearTimeout(timer);
        resolve();
      };
      ws.close(1000);
    });
  }

  private handleMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") {
      return;
    }
    const message = parseServerMessage(event.data);
    if (!message) {
      return;
    }

    if (DEBUG_ELEVENLABS) {
      console.log(
        `[elevenlabs-debug] ${message.message_type} @ ${performance
          .now()
          .toFixed(1)}ms`,
        message
      );
    }

    if (CAPACITY_ERROR_TYPES.has(message.message_type)) {
      this.errorAlreadyReported = true;
      this.callbacks.onError?.(new SessionCapacityError());
      return;
    }
    if (REQUEST_ERROR_TYPES.has(message.message_type)) {
      this.errorAlreadyReported = true;
      this.callbacks.onError?.(
        new Error(`ElevenLabs STT error: ${message.message_type}`)
      );
      return;
    }

    switch (message.message_type) {
      case "session_started": {
        this.sessionId = message.session_id ?? null;
        if (this.pendingOpen) {
          const pending = this.pendingOpen;
          this.pendingOpen = null;
          this.state = "open";
          pending.resolve();
        }
        break;
      }
      case "partial_transcript": {
        if (typeof message.text === "string") {
          this.callbacks.onPartialTranscript?.({ transcript: message.text });
        } else {
          console.warn(
            "[elevenlabs-stream] partial_transcript missing string `text`",
            message
          );
        }
        // A new partial means a fresh turn is underway.
        this.turnFinalized = false;
        break;
      }
      case "final_transcript": {
        // Not observed in practice under commit_strategy=vad (see the header
        // comment), but handled defensively in case it ever does arrive.
        this.finalizeTurn(message);
        break;
      }
      case "committed_transcript":
        // The actual finalization signal under commit_strategy=vad.
        this.finalizeTurn(message);
        break;
      case "final_transcript_with_timestamps":
      case "committed_transcript_with_timestamps":
        this.recordLatency(message);
        break;
      default:
        break;
    }
  }

  /** Fires onFinalTranscript at most once per turn, from whichever of
   * final_transcript / committed_transcript actually carries the text. */
  private finalizeTurn(message: ElevenLabsServerMessage): void {
    if (this.turnFinalized) {
      return;
    }
    if (typeof message.text !== "string") {
      console.warn(
        `[elevenlabs-stream] ${message.message_type} missing string \`text\``,
        message
      );
      return;
    }
    this.turnFinalized = true;
    this.callbacks.onFinalTranscript?.({ transcript: message.text });
  }

  /**
   * Computes latency from the last real word's `end` (seconds since session
   * start, converted to ms) to the receipt of this *_with_timestamps message,
   * and records it as both the word-emission and turn-detection sample — see
   * the header comment for why both metrics collapse to the same formula for
   * this provider, unlike Inworld's per-word incremental measurement.
   */
  private recordLatency(message: ElevenLabsServerMessage): void {
    if (this.audioClockBase === null) {
      return;
    }
    const words = (message.words ?? []).filter((w) => w.type === "word");
    if (words.length === 0) {
      return;
    }
    const lastWord = words[words.length - 1];
    const receivedAt = performance.now();
    // audioClockBase + (end * 1000) is the wall-clock moment speech stopped.
    const speechEndAt = this.audioClockBase + lastWord.end * 1000;
    const latency = receivedAt - speechEndAt;

    if (latency >= 0 && latency < MAX_PLAUSIBLE_LATENCY_MS) {
      this.pushWordLatencySample(latency);
    }
    if (latency >= 0 && latency < MAX_PLAUSIBLE_TURN_MS) {
      this.pushTurnLatencySample(latency);
    }

    if (DEBUG_ELEVENLABS) {
      console.log(`[elevenlabs-debug] ${message.message_type} latency`, {
        latencyMs: Math.round(latency),
        wordEmissionP50Ms: this.wordEmissionP50Ms,
        turnDetectionP50Ms: this.turnDetectionP50Ms,
      });
    }
  }

  private pushWordLatencySample(ms: number): void {
    this.latencySamples.push(ms);
    if (this.latencySamples.length > LATENCY_WINDOW) {
      this.latencySamples.shift();
    }
    const p50 = median(this.latencySamples);
    if (p50 !== null) {
      this.callbacks.onWordEmissionLatency?.(p50);
    }
  }

  private pushTurnLatencySample(ms: number): void {
    this.turnLatencySamples.push(ms);
    if (this.turnLatencySamples.length > LATENCY_WINDOW) {
      this.turnLatencySamples.shift();
    }
    const p50 = median(this.turnLatencySamples);
    if (p50 !== null) {
      this.callbacks.onTurnDetectionLatency?.(p50);
    }
  }

  private handleClose(event: CloseEvent): void {
    const wasTerminating = this.state === "terminating";
    this.ws = null;
    this.state = "closed";
    this.clearHiddenTimer();
    this.detachPageLifecycleHandlers();

    if (this.pendingOpen) {
      const pending = this.pendingOpen;
      this.pendingOpen = null;
      pending.reject(
        new Error(
          `Connection closed before session began (code ${event.code}` +
            `${event.reason ? `: ${event.reason}` : ""})`
        )
      );
      return;
    }

    if (this.onClosed) {
      const done = this.onClosed;
      this.onClosed = null;
      done();
    }

    if (
      event.code !== 1000 &&
      !wasTerminating &&
      !this.errorAlreadyReported
    ) {
      this.callbacks.onError?.(
        new Error(
          `Session closed unexpectedly (code ${event.code}` +
            `${event.reason ? `: ${event.reason}` : ""})`
        )
      );
    }
    this.emitSessionEnd();
  }

  private failPendingOpen(error: Error): void {
    if (!this.pendingOpen) {
      return;
    }
    const pending = this.pendingOpen;
    this.pendingOpen = null;
    const ws = this.ws;
    this.ws = null;
    this.state = "closed";
    if (ws) {
      ws.onmessage = null;
      ws.onclose = null;
      ws.close();
    }
    pending.reject(error);
  }

  private emitSessionEnd(): void {
    if (this.sessionEnded) {
      return;
    }
    this.sessionEnded = true;
    // ElevenLabs' realtime protocol carries no end-of-session usage summary
    // in this wire protocol, so there's nothing to report.
    this.callbacks.onSessionEnd?.(null);
  }

  // Arrow properties so `this` stays bound when used as event listeners.
  private readonly handleBeforeUnload = (): void => {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.close(1000);
      } catch {
        // Nothing more we can do during unload.
      }
    }
  };

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      if (this.hiddenTimer === null && this.state === "open") {
        this.hiddenTimer = window.setTimeout(() => {
          this.hiddenTimer = null;
          void this.stop();
        }, HIDDEN_TAB_TERMINATE_MS);
      }
    } else {
      this.clearHiddenTimer();
    }
  };

  private attachPageLifecycleHandlers(): void {
    if (this.listenersAttached || typeof window === "undefined") {
      return;
    }
    window.addEventListener("beforeunload", this.handleBeforeUnload);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.listenersAttached = true;
  }

  private detachPageLifecycleHandlers(): void {
    if (!this.listenersAttached) {
      return;
    }
    window.removeEventListener("beforeunload", this.handleBeforeUnload);
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange
    );
    this.listenersAttached = false;
  }

  private clearHiddenTimer(): void {
    if (this.hiddenTimer !== null) {
      window.clearTimeout(this.hiddenTimer);
      this.hiddenTimer = null;
    }
  }
}

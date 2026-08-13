// lib/inworld-stream.ts
//
// One live Inworld Realtime STT session, implementing the shared
// TranscriptionProvider contract so it's a drop-in alternative to
// AssemblyAIStream. The browser fetches a short-lived Inworld session token
// from /api/inworld-token, then connects straight to Inworld's STT WebSocket —
// no relay — passing the token in the query string.
//
// Wire protocol (Inworld `transcribe:streamBidirectional`):
//   → first frame: {"transcribeConfig":{ modelId, audioEncoding, ... }}
//   → audio:       {"audioChunk":{"content":"<base64 LINEAR16 PCM>"}}
//   → end:         {"closeStream":{}}
//   ← results:     {"result":{"transcription":{transcript,isFinal,…}}}
//                  {"result":{"usage":{transcribedAudioMs,modelId}}}
//                  {"result":{"speechStarted"|"speechStopped":…}}
// Inworld's automatic turn detection is the analog of AssemblyAI's
// end_of_turn: isFinal:false ⇒ partial, isFinal:true ⇒ final.

import type {
  SessionEndInfo,
  SessionState,
  TranscriptionCallbacks,
  TranscriptionProvider,
} from "./transcription-provider";
import { SessionCapacityError } from "./transcription-provider";

export { SessionCapacityError };
export type { SessionState };

const TOKEN_ENDPOINT = "/api/inworld-token";
const STT_ENDPOINT =
  "wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional";
const MODEL_ID = "inworld/inworld-stt-1";
const AUDIO_ENCODING = "LINEAR16";
const SAMPLE_RATE = 16000;
const LANGUAGE = "en";

// Mirror the AssemblyAI client's cleanup discipline: streaming is billed on
// connection time, so every exit path must close the socket.
const HIDDEN_TAB_TERMINATE_MS = 30_000;
const OPEN_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 5_000;

// Latency measurement — kept identical to lib/assemblyai-stream.ts so the two
// providers feed the same metrics with the same semantics.
const BYTES_PER_SAMPLE = 2; // 16-bit mono PCM ⇒ 2 bytes per sample.
const LATENCY_WINDOW = 50; // rolling window of per-word latency samples.
const MAX_PLAUSIBLE_LATENCY_MS = 5_000; // above this is a stale anchor, not real.
const MAX_PLAUSIBLE_TURN_MS = 10_000; // turn detection includes the endpoint wait.

// The Inworld client speaks the shared provider callback contract; the alias
// keeps call sites specific to this client readable.
export type InworldStreamCallbacks = TranscriptionCallbacks;

interface InworldWord {
  word: string;
  confidence: number;
  /** Offset from the start of the audio to the start of this word, in ms. */
  startTimeMs: number;
  /** Offset from the start of the audio to the end of this word, in ms. */
  endTimeMs: number;
  speaker?: number;
}

interface TranscriptionPayload {
  transcript?: string;
  isFinal?: boolean;
  /** Per-word timing, present because we request includeWordTimestamps. */
  wordTimestamps?: InworldWord[];
}

interface UsagePayload {
  transcribedAudioMs?: number;
  modelId?: string;
}

interface InworldResult {
  transcription?: TranscriptionPayload;
  usage?: UsagePayload;
  speechStarted?: unknown;
  speechStopped?: unknown;
  error?: unknown;
}

interface InworldServerMessage {
  result?: InworldResult;
  error?: unknown;
}

/** Encodes raw PCM bytes as base64 for the audioChunk `content` field. */
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

function parseServerMessage(raw: string): InworldServerMessage | null {
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data === "object" && data !== null) {
      return data as InworldServerMessage;
    }
  } catch {
    // Malformed frame; ignore.
  }
  return null;
}

/**
 * Manages one Inworld Realtime STT streaming session.
 *
 * ```ts
 * const stream = new InworldStream({
 *   onPartialTranscript: (r) => console.log("partial:", r.transcript),
 *   onFinalTranscript: (r) => console.log("final:", r.transcript),
 * });
 * await stream.start();
 * capture.start((chunk) => stream.sendAudio(chunk));
 * // ...
 * await stream.stop();
 * ```
 */
export class InworldStream implements TranscriptionProvider {
  private readonly callbacks: TranscriptionCallbacks;
  private ws: WebSocket | null = null;
  private state: SessionState = "idle";
  private sessionEnded = false;
  private usage: UsagePayload | null = null;
  private pendingOpen: {
    resolve: () => void;
    reject: (err: Error) => void;
  } | null = null;
  private onClosed: (() => void) | null = null;
  private hiddenTimer: number | null = null;
  private listenersAttached = false;
  // Latency measurement: anchor audio-stream time 0 to the wall clock, then for
  // each word compare (message received) − (audio sent) and report a rolling
  // median — identical to the AssemblyAI client.
  private audioClockBase: number | null = null;
  private latencySamples: number[] = [];
  private turnLatencySamples: number[] = [];
  private measuredWordCount = 0;

  constructor(callbacks: TranscriptionCallbacks = {}) {
    this.callbacks = callbacks;
  }

  get sessionState(): SessionState {
    return this.state;
  }

  // Inworld's streaming socket doesn't hand back a session id on the wire (it
  // lives inside the minted token), so there's nothing meaningful to expose.
  get id(): string | null {
    return null;
  }

  /** Rolling median (p50) word-emission latency in ms, or null before any word. */
  get wordEmissionP50Ms(): number | null {
    return median(this.latencySamples);
  }

  /** Rolling median (p50) turn-detection latency in ms, or null before any turn. */
  get turnDetectionP50Ms(): number | null {
    return median(this.turnLatencySamples);
  }

  /** Fetches a token, opens the socket, and resolves once it's ready for audio. */
  async start(): Promise<void> {
    if (this.state !== "idle" && this.state !== "closed") {
      throw new Error(`Cannot start a session in state "${this.state}"`);
    }
    this.state = "connecting";
    this.sessionEnded = false;
    this.usage = null;
    this.audioClockBase = null;
    this.latencySamples = [];
    this.turnLatencySamples = [];
    this.measuredWordCount = 0;

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

    const url = `${STT_ENDPOINT}?authorization=${encodeURIComponent(
      `Bearer ${token}`
    )}`;

    await new Promise<void>((resolve, reject) => {
      const openTimeout = window.setTimeout(() => {
        this.failPendingOpen(new Error("Timed out opening Inworld STT socket"));
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
      ws.onopen = () => this.handleOpen();
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
      JSON.stringify({ audioChunk: { content: arrayBufferToBase64(chunk) } })
    );
    // Anchor stream time 0 to the wall clock on the first chunk, so a word's
    // endTimeMs can be mapped back to the moment its audio was sent.
    if (this.audioClockBase === null) {
      const chunkMs =
        (chunk.byteLength / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000;
      // This first chunk carries stream time [0, chunkMs); its last sample was
      // just captured, so stream time 0 sits chunkMs in the past.
      this.audioClockBase = performance.now() - chunkMs;
    }
  }

  /**
   * Gracefully ends the session: sends closeStream, waits for the server to
   * finalize and close (which flushes any in-flight final transcript), then
   * ensures the socket is closed. Safe to call multiple times.
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

    if (ws.readyState !== WebSocket.OPEN) {
      // Still connecting (or already closing): nothing to flush, just make sure
      // the socket dies. handleClose finishes the cleanup.
      this.state = "terminating";
      ws.close();
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
      try {
        ws.send(JSON.stringify({ closeStream: {} }));
      } catch {
        window.clearTimeout(timer);
        this.onClosed = null;
        resolve();
      }
    });

    // Close ourselves if the server hasn't after flushing.
    if (
      this.ws === ws &&
      (ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING)
    ) {
      ws.close(1000);
    }
  }

  private handleOpen(): void {
    const ws = this.ws;
    if (!ws) {
      return;
    }
    // The config frame must precede any audio.
    try {
      ws.send(
        JSON.stringify({
          transcribeConfig: {
            modelId: MODEL_ID,
            audioEncoding: AUDIO_ENCODING,
            sampleRateHertz: SAMPLE_RATE,
            language: LANGUAGE,
            // Per-word timing drives the word-emission / turn-detection metrics.
            includeWordTimestamps: true,
          },
        })
      );
    } catch (err) {
      this.failPendingOpen(
        err instanceof Error ? err : new Error("Failed to send transcribeConfig")
      );
      return;
    }
    if (this.pendingOpen) {
      const pending = this.pendingOpen;
      this.pendingOpen = null;
      this.state = "open";
      pending.resolve();
    }
  }

  private handleMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") {
      return;
    }
    const message = parseServerMessage(event.data);
    if (!message) {
      return;
    }

    const result = message.result;

    // Surface auth/other server errors the same way a dropped socket would.
    if (message.error || result?.error) {
      this.callbacks.onError?.(
        new Error(`Inworld STT error: ${event.data.slice(0, 200)}`)
      );
      return;
    }
    if (!result) {
      return;
    }

    if (result.usage) {
      this.usage = result.usage;
    }

    const transcription = result.transcription;
    if (transcription && typeof transcription.transcript === "string") {
      // Measure word-emission latency on every result — partial or final —
      // from each word's first appearance.
      this.recordWordLatencies(transcription.wordTimestamps);
      const payload = { transcript: transcription.transcript };
      if (transcription.isFinal) {
        // Turn-detection latency is only meaningful on the finalized turn.
        this.recordTurnLatency(transcription.wordTimestamps);
        // The next utterance is a fresh turn, so restart word counting.
        this.measuredWordCount = 0;
        this.callbacks.onFinalTranscript?.(payload);
      } else {
        this.callbacks.onPartialTranscript?.(payload);
      }
    }
  }

  /**
   * Records the transcription latency of every newly-appeared word in a result:
   * the delay between sending the audio through that word's end and receiving
   * the message that first contains it. Runs on partials and finals, since a
   * word usually surfaces in a partial first. Mirrors the AssemblyAI client's
   * word-emission metric.
   */
  private recordWordLatencies(words: InworldWord[] | undefined): void {
    if (this.audioClockBase === null || !words || words.length === 0) {
      return;
    }
    // Inworld's partials are cumulative within a turn; a shorter array than
    // we've already measured means a new turn started, so reset the counter.
    if (words.length < this.measuredWordCount) {
      this.measuredWordCount = 0;
    }
    if (words.length <= this.measuredWordCount) {
      return;
    }
    const receivedAt = performance.now();
    for (let i = this.measuredWordCount; i < words.length; i++) {
      // audioClockBase + endTimeMs is the wall-clock moment that audio was sent.
      const audioSentAt = this.audioClockBase + words[i].endTimeMs;
      const latency = receivedAt - audioSentAt;
      if (latency >= 0 && latency < MAX_PLAUSIBLE_LATENCY_MS) {
        this.pushLatencySample(latency);
      }
    }
    this.measuredWordCount = words.length;
  }

  private pushLatencySample(ms: number): void {
    this.latencySamples.push(ms);
    if (this.latencySamples.length > LATENCY_WINDOW) {
      this.latencySamples.shift();
    }
    const p50 = median(this.latencySamples);
    if (p50 !== null) {
      this.callbacks.onWordEmissionLatency?.(p50);
    }
  }

  /**
   * Records turn-detection latency for a finalized turn: the delay between the
   * moment speech stopped (the last word's audio end) and receiving the
   * isFinal result. Mirrors the AssemblyAI client's turn-detection metric.
   */
  private recordTurnLatency(words: InworldWord[] | undefined): void {
    if (this.audioClockBase === null || !words || words.length === 0) {
      return;
    }
    const lastWord = words[words.length - 1];
    // audioClockBase + endTimeMs is the wall-clock moment speech stopped.
    const speechStoppedAt = this.audioClockBase + lastWord.endTimeMs;
    const latency = performance.now() - speechStoppedAt;
    if (latency < 0 || latency >= MAX_PLAUSIBLE_TURN_MS) {
      return;
    }
    this.turnLatencySamples.push(latency);
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

    if (event.code !== 1000 && !wasTerminating) {
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
      ws.onopen = null;
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
    this.callbacks.onSessionEnd?.(this.toSessionEndInfo());
  }

  private toSessionEndInfo(): SessionEndInfo | null {
    if (!this.usage || typeof this.usage.transcribedAudioMs !== "number") {
      return null;
    }
    return { audioDurationSeconds: this.usage.transcribedAudioMs / 1000 };
  }

  // Arrow properties so `this` stays bound when used as event listeners.
  private readonly handleBeforeUnload = (): void => {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ closeStream: {} }));
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

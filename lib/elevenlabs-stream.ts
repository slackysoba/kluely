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
// final_transcript (not committed_transcript) drives onFinalTranscript: it's
// already immutable and arrives before the ~1.5s VAD silence window elapses,
// so waiting for the commit would add that latency to the Gemini pipeline.
//
// Error events arrive as a message immediately before the server closes the
// socket, so they're handled in onmessage; handleClose suppresses its own
// "closed unexpectedly" report once an error message has already surfaced
// one, to avoid reporting the same failure twice.

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
// Do NOT add filter_background_audio — it's incompatible with
// include_timestamps and the socket will reject the connection.

// Mirror the other clients' cleanup discipline: streaming is billed on
// connection time, so every exit path must close the socket.
const HIDDEN_TAB_TERMINATE_MS = 30_000;
const OPEN_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 5_000;

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

interface ElevenLabsServerMessage {
  message_type: string;
  text?: string;
  session_id?: string;
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
  private pendingOpen: {
    resolve: () => void;
    reject: (err: Error) => void;
  } | null = null;
  private onClosed: (() => void) | null = null;
  private hiddenTimer: number | null = null;
  private listenersAttached = false;

  constructor(callbacks: TranscriptionCallbacks = {}) {
    this.callbacks = callbacks;
  }

  get sessionState(): SessionState {
    return this.state;
  }

  get id(): string | null {
    return this.sessionId;
  }

  // TODO(next step): latency metrics via final_transcript_with_timestamps /
  // committed_transcript_with_timestamps.
  get wordEmissionP50Ms(): number | null {
    return null;
  }

  get turnDetectionP50Ms(): number | null {
    return null;
  }

  /** Fetches a fresh single-use token, opens the socket, and resolves once the session has begun. */
  async start(): Promise<void> {
    if (this.state !== "idle" && this.state !== "closed") {
      throw new Error(`Cannot start a session in state "${this.state}"`);
    }
    this.state = "connecting";
    this.sessionId = null;
    this.sessionEnded = false;
    this.errorAlreadyReported = false;

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
        break;
      }
      case "final_transcript": {
        if (typeof message.text === "string") {
          this.callbacks.onFinalTranscript?.({ transcript: message.text });
        } else {
          console.warn(
            "[elevenlabs-stream] final_transcript missing string `text`",
            message
          );
        }
        break;
      }
      case "committed_transcript":
        // Ignored for text: final_transcript already delivered this turn's
        // text, ahead of the commit. This is only a durability signal.
        break;
      case "final_transcript_with_timestamps":
      case "committed_transcript_with_timestamps":
        // TODO(next step): latency metrics. (Logged above when DEBUG_ELEVENLABS.)
        break;
      default:
        break;
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

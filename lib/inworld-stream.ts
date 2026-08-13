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

// The Inworld client speaks the shared provider callback contract; the alias
// keeps call sites specific to this client readable.
export type InworldStreamCallbacks = TranscriptionCallbacks;

interface TranscriptionPayload {
  transcript?: string;
  isFinal?: boolean;
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

  // Latency is not measured for Inworld yet; the shared getters exist so the
  // provider satisfies the interface. (Word/turn timing could later be derived
  // from wordTimestamps + speechStopped once includeWordTimestamps is enabled.)
  get wordEmissionP50Ms(): number | null {
    return null;
  }

  get turnDetectionP50Ms(): number | null {
    return null;
  }

  /** Fetches a token, opens the socket, and resolves once it's ready for audio. */
  async start(): Promise<void> {
    if (this.state !== "idle" && this.state !== "closed") {
      throw new Error(`Cannot start a session in state "${this.state}"`);
    }
    this.state = "connecting";
    this.sessionEnded = false;
    this.usage = null;

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
      const payload = { transcript: transcription.transcript };
      if (transcription.isFinal) {
        this.callbacks.onFinalTranscript?.(payload);
      } else {
        this.callbacks.onPartialTranscript?.(payload);
      }
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

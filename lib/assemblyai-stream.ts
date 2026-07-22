const TOKEN_ENDPOINT = "/api/token";
const STREAMING_ENDPOINT = "wss://streaming.assemblyai.com/v3/ws";
const SAMPLE_RATE = 16000;

// Streaming is billed on wall-clock connection time, not audio sent, so an
// abandoned socket costs real money until the server force-closes it after
// 3 hours. Every exit path below must end with a Terminate message.
const HIDDEN_TAB_TERMINATE_MS = 30_000;
const BEGIN_TIMEOUT_MS = 10_000;
const TERMINATION_TIMEOUT_MS = 5_000;

export interface TurnWord {
  text: string;
  start: number;
  end: number;
  confidence: number;
  word_is_final: boolean;
}

export interface BeginMessage {
  type: "Begin";
  id: string;
  expires_at: number;
}

export interface TurnMessage {
  type: "Turn";
  turn_order: number;
  end_of_turn: boolean;
  turn_is_formatted: boolean;
  transcript: string;
  end_of_turn_confidence?: number;
  words?: TurnWord[];
}

export interface TerminationMessage {
  type: "Termination";
  audio_duration_seconds: number;
  session_duration_seconds: number;
}

// The server may also send types we don't handle (e.g. SpeechStarted).
type ServerMessage =
  | BeginMessage
  | TurnMessage
  | TerminationMessage
  | { type: string };

export type SessionState =
  | "idle"
  | "connecting"
  | "open"
  | "terminating"
  | "closed";

export interface AssemblyAIStreamCallbacks {
  /** Turn message with end_of_turn: false — in-progress transcript. */
  onPartialTranscript?: (turn: TurnMessage) => void;
  /**
   * Turn message with end_of_turn: true — finalized, formatted transcript.
   * `latencyMs` is the time between sending the last audio chunk before this
   * final and receiving it, or null if no audio had been sent yet.
   */
  onFinalTranscript?: (turn: TurnMessage, latencyMs: number | null) => void;
  onError?: (error: Error) => void;
  /**
   * Fired once when the session is over, however it ended. `termination` is
   * the server's Termination message (with billed session duration) when the
   * session ended cleanly, or null if the socket dropped without one.
   */
  onSessionEnd?: (termination: TerminationMessage | null) => void;
}

/** Thrown when the demo's session-concurrency cap rejects a new session. */
export class SessionCapacityError extends Error {
  constructor() {
    super("All demo session slots are currently in use");
    this.name = "SessionCapacityError";
  }
}

function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const data: unknown = JSON.parse(raw);
    if (
      typeof data === "object" &&
      data !== null &&
      typeof (data as { type?: unknown }).type === "string"
    ) {
      return data as ServerMessage;
    }
  } catch {
    // Malformed frame; ignore.
  }
  return null;
}

/**
 * Manages one AssemblyAI Universal-Streaming (v3) transcription session.
 *
 * ```ts
 * const stream = new AssemblyAIStream({
 *   onFinalTranscript: (turn, latencyMs) => console.log(turn.transcript, latencyMs),
 * });
 * await stream.start();
 * capture.start((chunk) => stream.sendAudio(chunk));
 * // ...
 * await stream.stop();
 * ```
 */
export class AssemblyAIStream {
  private readonly callbacks: AssemblyAIStreamCallbacks;
  private ws: WebSocket | null = null;
  private state: SessionState = "idle";
  private sessionId: string | null = null;
  private sessionEnded = false;
  private terminationInfo: TerminationMessage | null = null;
  private pendingBegin: {
    resolve: () => void;
    reject: (err: Error) => void;
  } | null = null;
  private onTerminated: (() => void) | null = null;
  private hiddenTimer: number | null = null;
  private listenersAttached = false;
  private lastAudioSentAt: number | null = null;
  private latestTurnLatencyMs: number | null = null;

  constructor(callbacks: AssemblyAIStreamCallbacks = {}) {
    this.callbacks = callbacks;
  }

  get sessionState(): SessionState {
    return this.state;
  }

  get id(): string | null {
    return this.sessionId;
  }

  /** Latency of the most recent finalized turn, in ms. */
  get lastTurnLatencyMs(): number | null {
    return this.latestTurnLatencyMs;
  }

  /** Fetches a token, opens the socket, and resolves once the session has begun. */
  async start(): Promise<void> {
    if (this.state !== "idle" && this.state !== "closed") {
      throw new Error(`Cannot start a session in state "${this.state}"`);
    }
    this.state = "connecting";
    this.sessionEnded = false;
    this.sessionId = null;
    this.terminationInfo = null;
    this.lastAudioSentAt = null;

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
      sample_rate: String(SAMPLE_RATE),
      token,
    });

    await new Promise<void>((resolve, reject) => {
      const beginTimeout = window.setTimeout(() => {
        this.failPendingBegin(new Error("Timed out waiting for session to begin"));
      }, BEGIN_TIMEOUT_MS);

      this.pendingBegin = {
        resolve: () => {
          window.clearTimeout(beginTimeout);
          resolve();
        },
        reject: (err: Error) => {
          window.clearTimeout(beginTimeout);
          reject(err);
        },
      };

      const ws = new WebSocket(`${STREAMING_ENDPOINT}?${params.toString()}`);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.onmessage = (event: MessageEvent) => this.handleMessage(event);
      ws.onclose = (event: CloseEvent) => this.handleClose(event);
    });

    this.attachPageLifecycleHandlers();
  }

  /** Sends one chunk of 16kHz mono 16-bit PCM audio. Drops it if not connected. */
  sendAudio(chunk: ArrayBuffer): void {
    if (this.state !== "open" || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(chunk);
    this.lastAudioSentAt = performance.now();
  }

  /**
   * Gracefully ends the session: sends Terminate, waits for the server's
   * Termination message (which flushes any in-flight final transcript), then
   * closes the socket. Safe to call multiple times.
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
      // Still connecting (or already closing): nothing to terminate, just
      // make sure the socket dies. handleClose finishes the cleanup.
      this.state = "terminating";
      ws.close();
      return;
    }

    this.state = "terminating";
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => {
        this.onTerminated = null;
        resolve();
      }, TERMINATION_TIMEOUT_MS);
      this.onTerminated = () => {
        window.clearTimeout(timer);
        resolve();
      };
      try {
        ws.send(JSON.stringify({ type: "Terminate" }));
      } catch {
        window.clearTimeout(timer);
        this.onTerminated = null;
        resolve();
      }
    });

    // The server normally closes with code 1000 after Termination; close
    // ourselves if it hasn't (e.g. the wait above timed out).
    if (
      this.ws === ws &&
      (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
    ) {
      ws.close(1000);
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

    switch (message.type) {
      case "Begin": {
        const begin = message as BeginMessage;
        this.sessionId = begin.id;
        if (this.pendingBegin) {
          const pending = this.pendingBegin;
          this.pendingBegin = null;
          this.state = "open";
          pending.resolve();
        }
        break;
      }
      case "Turn": {
        const turn = message as TurnMessage;
        if (turn.end_of_turn) {
          const latencyMs =
            this.lastAudioSentAt !== null
              ? Math.round(performance.now() - this.lastAudioSentAt)
              : null;
          this.latestTurnLatencyMs = latencyMs;
          this.callbacks.onFinalTranscript?.(turn, latencyMs);
        } else {
          this.callbacks.onPartialTranscript?.(turn);
        }
        break;
      }
      case "Termination": {
        this.terminationInfo = message as TerminationMessage;
        if (this.onTerminated) {
          const done = this.onTerminated;
          this.onTerminated = null;
          done();
        }
        break;
      }
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

    if (this.pendingBegin) {
      const pending = this.pendingBegin;
      this.pendingBegin = null;
      pending.reject(
        new Error(
          `Connection closed before session began (code ${event.code}` +
            `${event.reason ? `: ${event.reason}` : ""})`
        )
      );
      return;
    }

    if (this.onTerminated) {
      const done = this.onTerminated;
      this.onTerminated = null;
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

  private failPendingBegin(error: Error): void {
    if (!this.pendingBegin) {
      return;
    }
    const pending = this.pendingBegin;
    this.pendingBegin = null;
    const ws = this.ws;
    this.ws = null;
    this.state = "closed";
    if (ws) {
      ws.onmessage = null;
      ws.onclose = null;
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "Terminate" }));
        } catch {
          // Socket is unusable; close below is all we can do.
        }
      }
      ws.close();
    }
    pending.reject(error);
  }

  private emitSessionEnd(): void {
    if (this.sessionEnded) {
      return;
    }
    this.sessionEnded = true;
    this.callbacks.onSessionEnd?.(this.terminationInfo);
  }

  // Arrow properties so `this` stays bound when used as event listeners.
  private readonly handleBeforeUnload = (): void => {
    // Best effort: the page is going away, so terminate synchronously rather
    // than leaving the session to accrue charges server-side.
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "Terminate" }));
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
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.listenersAttached = false;
  }

  private clearHiddenTimer(): void {
    if (this.hiddenTimer !== null) {
      window.clearTimeout(this.hiddenTimer);
      this.hiddenTimer = null;
    }
  }
}

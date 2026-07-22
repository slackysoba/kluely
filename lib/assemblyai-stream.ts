const TOKEN_ENDPOINT = "/api/token";
const STREAMING_ENDPOINT = "wss://streaming.assemblyai.com/v3/ws";
const SAMPLE_RATE = 16000;

// Streaming is billed on wall-clock connection time, not audio sent, so an
// abandoned socket costs real money until the server force-closes it after
// 3 hours. Every exit path below must end with a Terminate message.
const HIDDEN_TAB_TERMINATE_MS = 30_000;
const BEGIN_TIMEOUT_MS = 10_000;
const TERMINATION_TIMEOUT_MS = 5_000;

// 16-bit mono PCM ⇒ 2 bytes per audio sample.
const BYTES_PER_SAMPLE = 2;
// Rolling window of per-word latency samples behind the p50 readout.
const LATENCY_WINDOW = 50;
// Samples above this are a stale anchor or clock glitch, not real latency.
const MAX_PLAUSIBLE_LATENCY_MS = 5_000;
// Turn detection includes the endpointing silence wait, so it runs longer than
// word emission; anything past this is a stale anchor rather than real.
const MAX_PLAUSIBLE_TURN_MS = 10_000;

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
  /** Turn message with end_of_turn: true — finalized, formatted transcript. */
  onFinalTranscript?: (turn: TurnMessage) => void;
  /**
   * Fired whenever the rolling-median (p50) word-emission latency updates: the
   * time from a word finishing in the audio to that word first appearing in a
   * Turn message (partial or final), in milliseconds. This is the streaming
   * latency AssemblyAI publishes (~150ms server-side), measured end-to-end in
   * the browser so it also carries network round-trip and client buffering.
   */
  onWordEmissionLatency?: (p50Ms: number) => void;
  /**
   * Fired whenever the rolling-median (p50) turn-detection latency updates: the
   * time from speech stopping (the last word's audio end) to the server
   * signalling the turn is complete (end_of_turn), in milliseconds. Reflects
   * Universal-Streaming's endpointing and turn-detection speed.
   */
  onTurnDetectionLatency?: (p50Ms: number) => void;
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
  // Streaming-latency measurement: anchor audio-stream time 0 to the wall
  // clock, then for each word time (message received) − (audio sent) and
  // report a rolling median.
  private audioMsSent = 0;
  private audioClockBase: number | null = null;
  private latencySamples: number[] = [];
  private turnLatencySamples: number[] = [];
  private measuredTurnOrder: number | null = null;
  private measuredWordCount = 0;

  constructor(callbacks: AssemblyAIStreamCallbacks = {}) {
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

  /** Fetches a token, opens the socket, and resolves once the session has begun. */
  async start(): Promise<void> {
    if (this.state !== "idle" && this.state !== "closed") {
      throw new Error(`Cannot start a session in state "${this.state}"`);
    }
    this.state = "connecting";
    this.sessionEnded = false;
    this.sessionId = null;
    this.terminationInfo = null;
    this.audioMsSent = 0;
    this.audioClockBase = null;
    this.latencySamples = [];
    this.turnLatencySamples = [];
    this.measuredTurnOrder = null;
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
    // Track how much audio (in ms of stream time) we've sent and anchor stream
    // time 0 to the wall clock, so a word's `end` timestamp can be mapped back
    // to the moment its audio was sent.
    const chunkMs = (chunk.byteLength / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000;
    if (this.audioClockBase === null) {
      // This first chunk carries stream time [0, chunkMs); its last sample was
      // just captured, so stream time 0 sits chunkMs in the past.
      this.audioClockBase = performance.now() - chunkMs;
    }
    this.audioMsSent += chunkMs;
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
        // Measure word-emission latency on every Turn — partial or final — from
        // the first appearance of each word.
        this.recordWordLatencies(turn);
        if (turn.end_of_turn) {
          // Turn-detection latency is only meaningful on the finalized turn.
          this.recordTurnLatency(turn);
          this.callbacks.onFinalTranscript?.(turn);
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

  /**
   * Records the transcription latency of every newly-appeared word in a Turn:
   * the delay between sending the audio through that word's end and receiving
   * the message that first contains it. Runs on partials and finals, since a
   * word usually surfaces in a partial first. This is the metric AssemblyAI
   * publishes (~300ms p50), not the finalization tail.
   */
  private recordWordLatencies(turn: TurnMessage): void {
    if (this.audioClockBase === null || !turn.words || turn.words.length === 0) {
      return;
    }
    // Word indices only ever grow within a turn, so track how many we've
    // already timed and measure only the ones that just appeared.
    if (this.measuredTurnOrder !== turn.turn_order) {
      this.measuredTurnOrder = turn.turn_order;
      this.measuredWordCount = 0;
    }
    if (turn.words.length <= this.measuredWordCount) {
      return;
    }
    const receivedAt = performance.now();
    for (let i = this.measuredWordCount; i < turn.words.length; i++) {
      // `end` is ms of stream time; audioClockBase + end is the wall-clock
      // moment that audio was sent.
      const audioSentAt = this.audioClockBase + turn.words[i].end;
      const latency = receivedAt - audioSentAt;
      if (latency >= 0 && latency < MAX_PLAUSIBLE_LATENCY_MS) {
        this.pushLatencySample(latency);
      }
    }
    this.measuredWordCount = turn.words.length;
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
   * end_of_turn signal. Reflects Universal-Streaming's endpointing speed.
   */
  private recordTurnLatency(turn: TurnMessage): void {
    if (this.audioClockBase === null || !turn.words || turn.words.length === 0) {
      return;
    }
    const lastWord = turn.words[turn.words.length - 1];
    // audioClockBase + end is the wall-clock moment speech stopped.
    const speechStoppedAt = this.audioClockBase + lastWord.end;
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

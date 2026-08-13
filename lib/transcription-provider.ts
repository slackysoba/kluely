// lib/transcription-provider.ts
//
// Provider-agnostic contract for a live streaming transcription session. Both
// the AssemblyAI (lib/assemblyai-stream.ts) and Inworld (lib/inworld-stream.ts)
// clients implement this, so the app can swap providers behind one type without
// caring which service is doing the transcribing.

/** One transcript update — an in-progress partial or a finalized turn. */
export interface TranscriptionResult {
  /** The transcript text for this update. */
  transcript: string;
}

/**
 * Billed-session summary emitted once when a session ends cleanly (the
 * provider's own termination/usage message). Null when the socket dropped
 * without one. Fields are best-effort and provider-dependent.
 */
export interface SessionEndInfo {
  /** Seconds of audio the provider billed for, if reported. */
  audioDurationSeconds?: number;
  /** Wall-clock seconds the session was open, if reported. */
  sessionDurationSeconds?: number;
}

export type SessionState =
  | "idle"
  | "connecting"
  | "open"
  | "terminating"
  | "closed";

/**
 * Callbacks a consumer supplies to a transcription session. Partial vs. final
 * is distinguished by which callback fires, not by a flag on the payload.
 */
export interface TranscriptionCallbacks {
  /** In-progress transcript (not yet finalized). */
  onPartialTranscript?: (result: TranscriptionResult) => void;
  /** Finalized transcript for a completed turn. */
  onFinalTranscript?: (result: TranscriptionResult) => void;
  /**
   * Rolling-median (p50) word-emission latency in ms: the time from a word
   * finishing in the audio to that word first appearing in a transcript.
   * Providers that don't measure it simply never call this.
   */
  onWordEmissionLatency?: (p50Ms: number) => void;
  /**
   * Rolling-median (p50) turn-detection latency in ms: the time from speech
   * stopping to the provider signalling the turn is complete. Providers that
   * don't measure it simply never call this.
   */
  onTurnDetectionLatency?: (p50Ms: number) => void;
  onError?: (error: Error) => void;
  /**
   * Fired exactly once when the session is over, however it ended. `info` is
   * the provider's end-of-session summary, or null if the socket dropped
   * without one.
   */
  onSessionEnd?: (info: SessionEndInfo | null) => void;
}

/**
 * A live streaming transcription session. Lifecycle: `start()` opens the
 * session, `sendAudio()` streams 16kHz mono 16-bit PCM, `stop()` ends it
 * cleanly. Latency getters return null until the provider has a sample (or
 * always, for providers that don't measure that dimension).
 */
export interface TranscriptionProvider {
  readonly sessionState: SessionState;
  /** Provider session id once established, else null. */
  readonly id: string | null;
  readonly wordEmissionP50Ms: number | null;
  readonly turnDetectionP50Ms: number | null;
  /** Opens the session; resolves once it's ready to receive audio. */
  start(): Promise<void>;
  /** Sends one chunk of 16kHz mono 16-bit PCM audio. No-op if not open. */
  sendAudio(chunk: ArrayBuffer): void;
  /** Ends the session cleanly. Safe to call multiple times. */
  stop(): Promise<void>;
}

/** Thrown when the demo's session-concurrency cap rejects a new session. */
export class SessionCapacityError extends Error {
  constructor() {
    super("All demo session slots are currently in use");
    this.name = "SessionCapacityError";
  }
}

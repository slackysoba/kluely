"use client";

import { useCallback, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  AudioCapture,
  CaptureCancelledError,
  DisplayCaptureUnsupportedError,
  MicrophonePermissionError,
  TabAudioUnavailableError,
} from "@/lib/audio-capture";
import {
  AssemblyAIStream,
  SessionCapacityError,
} from "@/lib/assemblyai-stream";
import Logo from "@/components/Logo";

const WAVE_BARS = 40;
const FLAT_LEVELS = new Array<number>(WAVE_BARS).fill(0);

interface AnswerPayload {
  english: string;
  klingon: string;
  pIqaD: string;
  backTranslation: string;
}

type CaptureMode = "practice" | "live";

type SessionErrorKind =
  | "mic-denied"
  | "connection"
  | "busy"
  | "tab-audio"
  | "unsupported";

interface AnswerError {
  kind: "network" | "api" | "rate-limited";
  question: string;
}

function isAnswerPayload(data: unknown): data is AnswerPayload {
  if (typeof data !== "object" || data === null) {
    return false;
  }
  const record = data as Record<string, unknown>;
  return (
    typeof record.english === "string" &&
    typeof record.klingon === "string" &&
    typeof record.pIqaD === "string" &&
    typeof record.backTranslation === "string"
  );
}

/** Perceived loudness of one 16-bit PCM chunk, 0..1. */
function chunkLevel(chunk: ArrayBuffer): number {
  const samples = new Int16Array(chunk);
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] / 32768;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / samples.length);
  // RMS of speech rarely exceeds ~0.25; expand it into the visible range.
  return Math.min(1, Math.sqrt(rms) * 1.8);
}

function Waveform({ levels, active }: { levels: number[]; active: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={`flex h-12 items-center justify-center gap-[3px] transition-opacity duration-500 ${
        active ? "opacity-100" : "opacity-30"
      }`}
    >
      {levels.map((level, i) => (
        <span
          key={i}
          className="wave-bar w-[3px] rounded-full bg-foreground/50"
          style={{ height: `${4 + level * 40}px` }}
        />
      ))}
    </div>
  );
}

/** Designed panel for error and guidance states. */
function StatePanel({
  title,
  body,
  actionLabel,
  onAction,
  alert = false,
}: {
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
  alert?: boolean;
}) {
  return (
    <div
      role={alert ? "alert" : undefined}
      className="mx-auto flex w-full max-w-md flex-col items-center gap-3 rounded-2xl border border-line bg-surface/60 px-8 py-8 text-center"
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${alert ? "bg-accent" : "bg-faint"}`}
      />
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="text-sm leading-6 text-muted">{body}</p>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-2 rounded-full border border-line bg-background px-4 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-accent/70"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export default function Home() {
  const reducedMotion = useReducedMotion();

  const captureRef = useRef<AudioCapture | null>(null);
  const streamRef = useRef<AssemblyAIStream | null>(null);
  const answerAbortRef = useRef<AbortController | null>(null);

  const [mode, setMode] = useState<CaptureMode>("practice");
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [finals, setFinals] = useState<string[]>([]);
  const [partial, setPartial] = useState("");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [sessionError, setSessionError] = useState<SessionErrorKind | null>(
    null
  );
  const [levels, setLevels] = useState<number[]>(FLAT_LEVELS);

  const [answer, setAnswer] = useState<AnswerPayload | null>(null);
  const [answerLoading, setAnswerLoading] = useState(false);
  const [answerError, setAnswerError] = useState<AnswerError | null>(null);

  // Fired only for finalized turns (end_of_turn: true) — never partials.
  // A newer final cancels any in-flight request instead of racing it.
  const requestAnswer = useCallback(async (question: string) => {
    answerAbortRef.current?.abort();
    const controller = new AbortController();
    answerAbortRef.current = controller;
    setAnswerLoading(true);
    setAnswerError(null);

    try {
      const res = await fetch("/api/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
        signal: controller.signal,
      });
      // A newer final may have superseded this request while we awaited.
      if (answerAbortRef.current !== controller) {
        return;
      }
      if (res.status === 429) {
        setAnswerError({ kind: "rate-limited", question });
        setAnswer(null);
        setAnswerLoading(false);
        return;
      }
      const data: unknown = await res.json();
      if (!res.ok || !isAnswerPayload(data)) {
        setAnswerError({ kind: "api", question });
        setAnswer(null);
      } else {
        setAnswer(data);
      }
      setAnswerLoading(false);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return; // Superseded by a newer final; that request owns the UI now.
      }
      if (answerAbortRef.current === controller) {
        setAnswerError({ kind: "network", question });
        setAnswer(null);
        setAnswerLoading(false);
      }
    }
  }, []);

  const stopPipeline = useCallback(async () => {
    const capture = captureRef.current;
    const stream = streamRef.current;
    captureRef.current = null;
    streamRef.current = null;
    setRunning(false);
    setLevels(FLAT_LEVELS);
    // Stop the mic first so no audio is sent while the session terminates.
    if (capture) {
      await capture.stop();
    }
    if (stream) {
      await stream.stop();
    }
  }, []);

  const startPipeline = useCallback(async () => {
    setStarting(true);
    setSessionError(null);
    setFinals([]);
    setPartial("");
    setLatencyMs(null);
    setAnswer(null);
    setAnswerError(null);

    const stream = new AssemblyAIStream({
      onPartialTranscript: (turn) => setPartial(turn.transcript),
      onFinalTranscript: (turn, latency) => {
        setPartial("");
        setLatencyMs(latency);
        if (turn.transcript) {
          setFinals((prev) => [...prev, turn.transcript]);
          void requestAnswer(turn.transcript);
        }
      },
      onError: () => setSessionError("connection"),
      onSessionEnd: () => {
        // Covers server-side closes and the hidden-tab auto-terminate.
        void stopPipeline();
      },
    });
    const capture = new AudioCapture();
    streamRef.current = stream;
    captureRef.current = capture;

    try {
      // Acquire the audio source first: if the user cancels the picker or
      // denies the mic, no streaming session (and no demo slot) is spent.
      await capture.start(
        (chunk) => {
          stream.sendAudio(chunk);
          const level = chunkLevel(chunk);
          setLevels((prev) => [...prev.slice(1), level]);
        },
        {
          source: mode === "live" ? "tab" : "microphone",
          // Chrome's "Stop sharing" bar (or a vanished mic) ends the track;
          // terminate the streaming session properly instead of leaking it.
          onSourceEnded: () => void stopPipeline(),
        }
      );
      await stream.start();
      setRunning(true);
    } catch (err) {
      if (err instanceof CaptureCancelledError) {
        // Dismissing the picker is a decision, not a failure.
        await stopPipeline();
        return;
      }
      if (err instanceof MicrophonePermissionError) {
        setSessionError("mic-denied");
      } else if (err instanceof TabAudioUnavailableError) {
        setSessionError("tab-audio");
      } else if (err instanceof DisplayCaptureUnsupportedError) {
        setSessionError("unsupported");
      } else if (err instanceof SessionCapacityError) {
        setSessionError("busy");
      } else {
        setSessionError("connection");
        console.error(err);
      }
      await stopPipeline();
    } finally {
      setStarting(false);
    }
  }, [mode, requestAnswer, stopPipeline]);

  const toggleRecording = () => {
    if (running) {
      void stopPipeline();
    } else {
      void startPipeline();
    }
  };

  const retryAnswer = () => {
    if (answerError) {
      void requestAnswer(answerError.question);
    }
  };

  const switchMode = (next: CaptureMode) => {
    if (next === mode) {
      return;
    }
    if (running || starting) {
      void stopPipeline();
    }
    setSessionError(null);
    setMode(next);
  };

  const connectionLabel = starting
    ? "Connecting"
    : running
      ? "Listening"
      : "Offline";

  const hasTranscript = finals.length > 0 || partial.length > 0;
  const firstLoad =
    !running && !starting && !hasTranscript && !sessionError && !answer;
  const enter = reducedMotion
    ? { opacity: 0 }
    : ({ opacity: 0, y: 14 } as const);
  const entered = reducedMotion
    ? { opacity: 1 }
    : ({ opacity: 1, y: 0 } as const);

  return (
    <div className="flex min-h-screen flex-col">
      <main className="mx-auto flex w-full max-w-[720px] flex-1 flex-col items-center gap-12 px-6 pb-24 pt-20">
        <header className="flex flex-col items-center gap-4 text-center">
          <h1>
            <Logo className="h-10 w-auto" />
          </h1>
          <p className="text-sm text-muted">Interview coaching for Klingons.</p>
          {/* Mode: makes the capture scope explicit */}
          <div
            className="mt-1 inline-flex items-center rounded-full border border-line bg-surface p-0.5 text-xs"
            role="group"
            aria-label="Capture mode"
          >
            <button
              type="button"
              aria-pressed={mode === "practice"}
              onClick={() => switchMode("practice")}
              className={`rounded-full px-3.5 py-1 transition-colors ${
                mode === "practice"
                  ? "bg-background font-medium text-foreground"
                  : "text-muted hover:text-foreground"
              }`}
            >
              Practice
            </button>
            <button
              type="button"
              aria-pressed={mode === "live"}
              onClick={() => switchMode("live")}
              className={`rounded-full px-3.5 py-1 transition-colors ${
                mode === "live"
                  ? "bg-background font-medium text-foreground"
                  : "text-muted hover:text-foreground"
              }`}
            >
              Live
            </button>
          </div>
          <p className="text-xs text-faint">
            {mode === "practice"
              ? "Uses your microphone — answering what you say."
              : "Captures a browser tab — answering what they ask."}
          </p>
        </header>

        {/* Primary action */}
        <div className="flex flex-col items-center gap-6">
          <div className="relative">
            <AnimatePresence>
              {running && (
                <motion.span
                  aria-hidden="true"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.6 }}
                  className="absolute -inset-8 rounded-full bg-accent/15 blur-2xl"
                />
              )}
            </AnimatePresence>
            <button
            type="button"
            onClick={toggleRecording}
            disabled={starting}
            aria-pressed={running}
            aria-label={running ? "Stop listening" : "Start listening"}
            className={`relative flex h-24 w-24 items-center justify-center rounded-full border transition-colors duration-300 disabled:opacity-60 ${
              running
                ? "recording-pulse border-accent bg-accent"
                : "border-line bg-surface hover:border-accent/70"
            }`}
          >
              {running ? (
                <span className="h-7 w-7 rounded-[6px] bg-background" />
              ) : (
                <span className="h-7 w-7 rounded-full bg-accent" />
              )}
            </button>
          </div>
          <Waveform levels={levels} active={running} />
        </div>

        {/* Session state: first-load hint, errors, or live transcript */}
        <section
          aria-live="polite"
          aria-label="Live transcript"
          className="min-h-16 w-full text-center"
        >
          <AnimatePresence mode="wait">
            {sessionError === "mic-denied" ? (
              <motion.div
                key="mic-denied"
                initial={enter}
                animate={entered}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
              >
                <StatePanel
                  alert
                  title="Microphone access is blocked"
                  body="Kluely needs to hear the question. Allow microphone access for this site in your browser's address bar, then try again."
                  actionLabel="Try again"
                  onAction={() => void startPipeline()}
                />
              </motion.div>
            ) : sessionError === "tab-audio" ? (
              <motion.div
                key="tab-audio"
                initial={enter}
                animate={entered}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
              >
                <StatePanel
                  alert
                  title="No tab audio was shared"
                  body={
                    'Pick the meeting tab in Chrome’s picker and tick "Also share tab audio" at the bottom — sharing a window or screen won’t carry sound.'
                  }
                  actionLabel="Share again"
                  onAction={() => void startPipeline()}
                />
              </motion.div>
            ) : sessionError === "unsupported" ? (
              <motion.div
                key="unsupported"
                initial={enter}
                animate={entered}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
              >
                <StatePanel
                  alert
                  title="Tab capture isn't supported here"
                  body="This browser can't capture tab audio. Use Chrome or Edge on desktop, or switch to Practice mode and use your microphone."
                  actionLabel="Use Practice mode"
                  onAction={() => switchMode("practice")}
                />
              </motion.div>
            ) : sessionError === "busy" ? (
              <motion.div
                key="busy"
                initial={enter}
                animate={entered}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
              >
                <StatePanel
                  title="All demo slots are in use"
                  body="Kluely limits simultaneous sessions to stay inside its API budget. Slots free up within a few minutes."
                  actionLabel="Try again"
                  onAction={() => void startPipeline()}
                />
              </motion.div>
            ) : sessionError === "connection" ? (
              <motion.div
                key="connection-error"
                initial={enter}
                animate={entered}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
              >
                <StatePanel
                  alert
                  title="Connection lost"
                  body="The transcription session ended unexpectedly. Check your network and start again — nothing you said was lost."
                  actionLabel="Reconnect"
                  onAction={() => void startPipeline()}
                />
              </motion.div>
            ) : firstLoad ? (
              <motion.div
                key="first-load"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="flex flex-col items-center gap-2"
              >
                {mode === "practice" ? (
                  <>
                    <p className="text-sm text-muted">
                      Press the button and speak the interviewer&rsquo;s
                      question aloud.
                    </p>
                    <p className="text-sm text-faint">
                      Try{" "}
                      <span className="text-muted">
                        &ldquo;Where do you see yourself in five years?&rdquo;
                      </span>
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-muted">
                      Press the button, pick the meeting tab, and tick
                      &ldquo;Also share tab audio.&rdquo;
                    </p>
                    <p className="text-sm text-faint">
                      Kluely listens to that tab and answers each question it
                      hears.
                    </p>
                  </>
                )}
              </motion.div>
            ) : (
              <motion.div
                key="transcript"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
              >
                {hasTranscript ? (
                  <div className="flex flex-col gap-2">
                    <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-faint">
                      Question
                    </span>
                    <p className="text-base leading-7 text-muted">
                      {finals.join(" ")}
                      {partial && (
                        <span className="text-faint"> {partial}</span>
                      )}
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-faint">
                    {running
                      ? mode === "practice"
                        ? "Listening — speak the question."
                        : "Listening to the shared tab."
                      : "Connecting to transcription…"}
                  </p>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </section>

        {/* Answer */}
        <section aria-label="Answer" className="w-full flex-1">
          <AnimatePresence mode="wait">
            {answerLoading ? (
              <motion.div
                key="thinking"
                initial={enter}
                animate={entered}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="flex items-center justify-center gap-2 pt-6"
                aria-label="Composing answer"
              >
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="thinking-dot h-1.5 w-1.5 rounded-full bg-muted"
                    style={{ animationDelay: `${i * 0.2}s` }}
                  />
                ))}
              </motion.div>
            ) : answerError ? (
              <motion.div
                key="answer-error"
                initial={enter}
                animate={entered}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="pt-6"
              >
                {answerError.kind === "rate-limited" ? (
                  <StatePanel
                    title="The demo is popular right now"
                    body="Too many questions in the last minute. Give it a few seconds — your question is saved."
                    actionLabel="Retry"
                    onAction={retryAnswer}
                  />
                ) : (
                  <StatePanel
                    alert
                    title={
                      answerError.kind === "network"
                        ? "Couldn't reach the server"
                        : "Couldn't compose an answer"
                    }
                    body={
                      answerError.kind === "network"
                        ? "The request didn't make it out. Check your connection — your question is saved."
                        : "Something went wrong while generating the Klingon. Your question is saved, so just retry."
                    }
                    actionLabel="Retry"
                    onAction={retryAnswer}
                  />
                )}
              </motion.div>
            ) : answer ? (
              <motion.dl
                key={answer.klingon}
                initial={enter}
                animate={entered}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                className="flex flex-col gap-8 border-t border-line pt-10"
              >
                <div className="flex flex-col gap-2">
                  <dt className="text-[11px] font-medium uppercase tracking-[0.18em] text-faint">
                    Your answer
                  </dt>
                  <dd className="text-3xl font-semibold leading-tight tracking-tight">
                    {answer.klingon}
                  </dd>
                </div>
                <div className="flex flex-col gap-2">
                  <dt className="text-[11px] font-medium uppercase tracking-[0.18em] text-faint">
                    pIqaD
                  </dt>
                  <dd className="piqad text-2xl leading-snug text-foreground/90">
                    {answer.pIqaD}
                  </dd>
                </div>
                <div className="flex flex-col gap-2">
                  <dt className="text-[11px] font-medium uppercase tracking-[0.18em] text-faint">
                    Literal meaning
                  </dt>
                  <dd className="text-sm leading-6 text-muted">
                    {answer.backTranslation}
                  </dd>
                </div>
                <div className="flex flex-col gap-2 border-t border-line/60 pt-6">
                  <dt className="text-[11px] font-medium uppercase tracking-[0.18em] text-faint">
                    Federation Standard
                  </dt>
                  <dd className="text-sm leading-6 text-faint">
                    {answer.english}
                  </dd>
                </div>
              </motion.dl>
            ) : hasTranscript || running ? (
              <motion.p
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="pt-6 text-center text-sm text-faint"
              >
                Your answer will appear here.
              </motion.p>
            ) : null}
          </AnimatePresence>
        </section>
      </main>

      {/* Persistent status bar */}
      <footer className="fixed inset-x-0 bottom-0 border-t border-line bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-10 w-full max-w-[720px] items-center justify-between px-6 text-xs text-muted">
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${
                running ? "bg-accent" : starting ? "bg-muted" : "bg-faint"
              }`}
            />
            {mode === "practice" ? "Practice" : "Live"} · {connectionLabel}
          </span>
          <span className="font-mono tabular-nums">
            {latencyMs !== null ? `${latencyMs} ms` : "— ms"}
          </span>
        </div>
      </footer>
    </div>
  );
}

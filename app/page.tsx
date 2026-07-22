"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AnimatePresence,
  LayoutGroup,
  motion,
  useReducedMotion,
} from "framer-motion";
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
import Image from "next/image";
import Wordmark from "@/components/Wordmark";

const WAVE_BARS = 40;
const FLAT_LEVELS = new Array<number>(WAVE_BARS).fill(0);

const DONATION_URL = "https://buy.stripe.com/14A5kEg8HeQs1MrdLE28800";

// One id per magic-motion element, so framer glides them between layouts.
const ORB_ID = "record-orb";

// Rolling window for the end-to-end median measured client-side.
const E2E_WINDOW = 50;

// Info-tooltip copy for each sidebar latency metric.
const METRIC_INFO = {
  endToEnd:
    "Time from when you stop speaking to the Klingon answer appearing on " +
    "screen. Includes transcription, the language model generating the " +
    "Klingon, and rendering.",
  wordEmission:
    "Median time from when a word finishes in your audio to when it appears " +
    "as transcribed text, measured in the browser. This uses AssemblyAI's " +
    "own metric definition, but measured end-to-end — so it sits on top of " +
    "AssemblyAI's ~150ms server-side figure by the amount of network " +
    "round-trip and client buffering.",
  turnDetection:
    "Time from when you stop speaking to when AssemblyAI signals the turn is " +
    "complete (end_of_turn). Reflects Universal-Streaming's endpointing and " +
    "turn-detection speed.",
} as const;

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

/** Formats a latency reading for the rail, dashing out the empty state. */
function formatLatency(ms: number | null): string {
  return ms !== null ? `${ms}ms` : "—";
}

interface AnswerPayload {
  english: string;
  klingon: string;
  pIqaD: string;
  backTranslation: string;
}

interface HistoryEntry extends AnswerPayload {
  id: string;
  question: string;
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

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Compact amplitude meter for the left rail, driven by real mic levels. */
function RailWaveform({ levels, active }: { levels: number[]; active: boolean }) {
  const bars = levels.slice(-24);
  return (
    <div
      aria-hidden="true"
      className={`flex h-9 items-center justify-center gap-[2px] transition-opacity duration-500 ${
        active ? "opacity-100" : "opacity-30"
      }`}
    >
      {bars.map((level, i) => (
        <span
          key={i}
          className="wave-bar w-[2px] rounded-full bg-foreground/60"
          style={{ height: `${3 + level * 26}px` }}
        />
      ))}
    </div>
  );
}

/** Wide amplitude meter for the centered idle state. */
function CenterWaveform({
  levels,
  active,
}: {
  levels: number[];
  active: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      className={`flex h-10 items-center justify-center gap-[3px] transition-opacity duration-500 ${
        active ? "opacity-100" : "opacity-30"
      }`}
    >
      {levels.map((level, i) => (
        <span
          key={i}
          className="wave-bar w-[3px] rounded-full bg-foreground/50"
          style={{ height: `${4 + level * 32}px` }}
        />
      ))}
    </div>
  );
}

/** The record orb. Same layoutId in both layouts, so it swoops between them. */
function RecordOrb({
  variant,
  running,
  starting,
  onClick,
  transition,
}: {
  variant: "center" | "rail";
  running: boolean;
  starting: boolean;
  onClick: () => void;
  transition: object;
}) {
  const isCenter = variant === "center";
  return (
    <motion.button
      layoutId={ORB_ID}
      transition={transition}
      type="button"
      onClick={onClick}
      disabled={starting}
      aria-pressed={running}
      aria-label={running ? "Stop listening" : "Start listening"}
      className={`relative flex items-center justify-center rounded-full border transition-colors duration-300 disabled:opacity-60 ${
        isCenter ? "h-24 w-24 lg:h-[104px] lg:w-[104px]" : "h-16 w-16"
      } ${
        running
          ? "recording-pulse border-accent bg-accent"
          : "border-line bg-surface hover:border-accent/70"
      }`}
    >
      {/* The dot is its own shared-layout element so framer projects it
          concentrically with the button — same layoutId lifetime, same
          transition — instead of letting it ride the parent's scale and
          drift off its own arc. */}
      <motion.span
        layoutId={`${ORB_ID}-dot`}
        transition={transition}
        className={`${isCenter ? "h-7 w-7 lg:h-[30px] lg:w-[30px]" : "h-5 w-5"} ${
          running ? "rounded-[6px] bg-background" : "rounded-full bg-accent"
        }`}
      />
    </motion.button>
  );
}

/** Labelled numeric readout for the rail (timer, latency). */
function RailStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className="font-mono text-sm tabular-nums text-foreground">
        {value}
      </span>
      <span className="text-[10px] uppercase tracking-[0.16em] text-faint">
        {label}
      </span>
    </div>
  );
}

/**
 * A small "i" affordance that reveals a metric's description. Opens on hover
 * and keyboard focus (desktop) and on tap (touch, where hover never fires),
 * and carries an aria-label so it's reachable and named for screen readers.
 */
function MetricInfo({
  label,
  description,
}: {
  label: string;
  description: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();

  // While open, a tap or click anywhere outside dismisses it — the only way to
  // close the pinned-open state on touch, where there's no pointer-leave.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onDocPointer = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDocPointer);
    return () => document.removeEventListener("pointerdown", onDocPointer);
  }, [open]);

  return (
    <span ref={wrapRef} className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? tooltipId : undefined}
        // Touch has no hover: toggle on tap and suppress the emulated mouse
        // events (which would otherwise immediately reopen/close it).
        onPointerDown={(event) => {
          if (event.pointerType !== "mouse") {
            event.preventDefault();
            setOpen((prev) => !prev);
          }
        }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
          }
        }}
        className="flex h-3.5 w-3.5 items-center justify-center rounded-full border border-line font-serif text-[9px] normal-case italic leading-none text-faint transition-colors hover:border-accent/70 hover:text-foreground focus-visible:border-accent focus-visible:text-foreground"
      >
        i
      </button>
      {open && (
        <span
          role="tooltip"
          id={tooltipId}
          className="absolute left-full top-1/2 z-30 ml-2 w-48 -translate-y-1/2 rounded-lg border border-line bg-surface px-3 py-2 text-left text-[11px] font-normal normal-case not-italic leading-4 tracking-normal text-muted shadow-xl"
        >
          {description}
        </span>
      )}
    </span>
  );
}

/** A rail latency metric: name on top, number beneath, with an info tooltip. */
function MetricStat({
  name,
  value,
  description,
}: {
  name: string;
  value: string;
  description: string;
}) {
  return (
    <div className="flex w-full flex-col items-center gap-1">
      <span className="flex items-center gap-1 text-center text-[10px] uppercase leading-tight tracking-[0.12em] text-faint">
        {name}
        <MetricInfo label={`${name} — what this measures`} description={description} />
      </span>
      <span className="font-mono text-sm tabular-nums text-foreground">
        {value}
      </span>
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
      className="flex w-full max-w-md flex-col items-center gap-3 rounded-2xl border border-line bg-surface/60 px-8 py-8 text-center"
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

/** Small caps label used across the stage. */
function StageLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-faint">
      {children}
    </span>
  );
}

export default function Home() {
  const reducedMotion = useReducedMotion();

  const captureRef = useRef<AudioCapture | null>(null);
  const streamRef = useRef<AssemblyAIStream | null>(null);
  const answerAbortRef = useRef<AbortController | null>(null);
  const sessionStartRef = useRef<number | null>(null);
  const historyIdRef = useRef(0);
  // End-to-end latency spans the stream (end_of_turn) and the DOM (answer
  // painted), so it's measured here rather than in the stream: the wall clock
  // when the last final turn fired, plus its rolling sample window.
  const turnEndAtRef = useRef<number | null>(null);
  const e2eSamplesRef = useRef<number[]>([]);

  const [mode, setMode] = useState<CaptureMode>("practice");
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [currentQuestion, setCurrentQuestion] = useState("");
  const [partial, setPartial] = useState("");
  // Three rolling-median latency readouts shown in the recording rail.
  const [endToEndMs, setEndToEndMs] = useState<number | null>(null);
  const [wordEmissionMs, setWordEmissionMs] = useState<number | null>(null);
  const [turnDetectionMs, setTurnDetectionMs] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [sessionError, setSessionError] = useState<SessionErrorKind | null>(
    null
  );
  const [levels, setLevels] = useState<number[]>(FLAT_LEVELS);

  const [answer, setAnswer] = useState<AnswerPayload | null>(null);
  const [answerLoading, setAnswerLoading] = useState(false);
  const [answerError, setAnswerError] = useState<AnswerError | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  // Mirror the live exchange into refs so archiving reads the latest values
  // without threading them through every callback's dependency list.
  const answerRef = useRef<AnswerPayload | null>(null);
  const questionRef = useRef("");
  useEffect(() => {
    answerRef.current = answer;
  }, [answer]);
  useEffect(() => {
    questionRef.current = currentQuestion;
  }, [currentQuestion]);

  // Tick the session timer while listening; freezes when the session ends.
  useEffect(() => {
    if (!running) {
      return;
    }
    const tick = () => {
      if (sessionStartRef.current !== null) {
        setElapsedMs(Date.now() - sessionStartRef.current);
      }
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [running]);

  // Close the end-to-end loop: once an answer settles, measure from the
  // end_of_turn that requested it to the frame that paints the Klingon. The
  // rAF fires after the browser has committed the answer to the screen, so the
  // sample includes render — not just the moment state was set.
  useEffect(() => {
    if (!answer) {
      return;
    }
    const startedAt = turnEndAtRef.current;
    if (startedAt === null) {
      return;
    }
    turnEndAtRef.current = null;
    const raf = requestAnimationFrame(() => {
      const samples = e2eSamplesRef.current;
      samples.push(performance.now() - startedAt);
      if (samples.length > E2E_WINDOW) {
        samples.shift();
      }
      setEndToEndMs(median(samples));
    });
    return () => cancelAnimationFrame(raf);
  }, [answer]);

  // Move the settled answer (and its question) into the history log. Newest
  // on top; a no-op when there's nothing settled yet.
  const archiveCurrent = useCallback(() => {
    const settled = answerRef.current;
    const question = questionRef.current;
    if (settled && question) {
      const entry: HistoryEntry = {
        id: `h${historyIdRef.current++}`,
        question,
        ...settled,
      };
      setHistory((prev) => [entry, ...prev]);
    }
  }, []);

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
    // Preserve the last exchange in history as we return to idle.
    archiveCurrent();
    answerAbortRef.current?.abort();
    answerAbortRef.current = null;
    setRunning(false);
    setLevels(FLAT_LEVELS);
    setCurrentQuestion("");
    setPartial("");
    setAnswer(null);
    setAnswerLoading(false);
    // Stop the mic first so no audio is sent while the session terminates.
    if (capture) {
      await capture.stop();
    }
    if (stream) {
      await stream.stop();
    }
  }, [archiveCurrent]);

  const startPipeline = useCallback(async () => {
    setStarting(true);
    setSessionError(null);
    // Keep history; clear only the live turn.
    archiveCurrent();
    setCurrentQuestion("");
    setPartial("");
    setEndToEndMs(null);
    setWordEmissionMs(null);
    setTurnDetectionMs(null);
    turnEndAtRef.current = null;
    e2eSamplesRef.current = [];
    setElapsedMs(0);
    setAnswer(null);
    setAnswerError(null);
    setAnswerLoading(false);

    const stream = new AssemblyAIStream({
      onPartialTranscript: (turn) => setPartial(turn.transcript),
      onWordEmissionLatency: (p50) => setWordEmissionMs(p50),
      onTurnDetectionLatency: (p50) => setTurnDetectionMs(p50),
      onFinalTranscript: (turn) => {
        setPartial("");
        if (turn.transcript) {
          // Anchor the end-to-end clock the instant the turn finalizes; the
          // paint effect above stops it when this turn's answer renders.
          turnEndAtRef.current = performance.now();
          // The previous answer becomes history; this turn takes the stage.
          archiveCurrent();
          setCurrentQuestion(turn.transcript);
          setAnswer(null);
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
      sessionStartRef.current = Date.now();
      setElapsedMs(0);
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
  }, [mode, requestAnswer, stopPipeline, archiveCurrent]);

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

  const active = running || starting;
  const connectionLabel = starting
    ? "Connecting"
    : running
      ? "Listening"
      : "Offline";
  const heard = partial || currentQuestion;

  // Motion vocabulary. Reduced motion collapses every glide to a plain fade.
  const swoop = reducedMotion
    ? { duration: 0 }
    : { duration: 0.4, ease: [0.22, 1, 0.36, 1] as const };
  const fade = reducedMotion
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
        transition: { duration: 0.2 },
      }
    : {
        initial: { opacity: 0, y: 8 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0 },
        transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1] as const },
      };

  const sessionErrorPanel = sessionError && (
    <SessionErrorPanel
      kind={sessionError}
      onRetry={() => void startPipeline()}
      onUsePractice={() => switchMode("practice")}
    />
  );

  return (
    <div className="relative flex min-h-screen flex-col">
      {/* Donation aside, top right (desktop only). On mobile this absolute
          link floats over the header, so it's hidden here and shown in the
          footer instead — see below. */}
      <div className="group absolute right-6 top-6 z-10 hidden text-xs sm:block">
        <a
          href={DONATION_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-describedby="donation-note"
          className="flex items-center gap-1 text-muted transition-colors hover:text-accent focus-visible:text-accent"
        >
          Help Keep Cloaking Active!
          <span
            aria-hidden="true"
            className="transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
          >
            →
          </span>
        </a>
        <span
          id="donation-note"
          role="tooltip"
          className="pointer-events-none absolute right-0 top-full mt-2 whitespace-nowrap rounded-md border border-line bg-surface px-2.5 py-1 text-[11px] text-muted opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
        >
          Donations cover API costs.
        </span>
      </div>

      <main className="flex w-full flex-1 flex-col px-6 pb-28 pt-8 sm:pb-16">
        <LayoutGroup>
          {active ? (
            /* ---------- RECORDING: left rail + working stage ---------- */
            <div className="mx-auto w-full max-w-[1040px] xl:max-w-[1180px]">
              <motion.div
                {...fade}
                className="mb-8 flex items-center gap-2.5"
                aria-label="Kluely"
              >
                <Image
                  src="/logo.png"
                  alt=""
                  width={120}
                  height={160}
                  loading="eager"
                  className="h-6 w-auto"
                />
                <Wordmark className="h-5 w-auto" />
              </motion.div>

              <div className="flex gap-6 md:gap-8">
                <aside className="flex w-[130px] shrink-0 flex-col items-center gap-5 self-start rounded-2xl border border-line bg-surface/30 px-3 py-6">
                  <div className="relative flex items-center justify-center">
                    <AnimatePresence>
                      {running && (
                        <motion.span
                          aria-hidden="true"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.6 }}
                          className="absolute -inset-4 rounded-full bg-accent/15 blur-2xl"
                        />
                      )}
                    </AnimatePresence>
                    <RecordOrb
                      variant="rail"
                      running={running}
                      starting={starting}
                      onClick={toggleRecording}
                      transition={swoop}
                    />
                  </div>

                  <RailWaveform levels={levels} active={running} />

                  <div className="flex w-full flex-col items-center gap-4 border-t border-line/70 pt-4">
                    <RailStat label="Timer" value={formatElapsed(elapsedMs)} />
                    <div className="flex w-full flex-col items-center gap-4 border-t border-line/70 pt-4">
                      <MetricStat
                        name="End-to-end"
                        value={formatLatency(endToEndMs)}
                        description={METRIC_INFO.endToEnd}
                      />
                      <MetricStat
                        name="Word emission"
                        value={formatLatency(wordEmissionMs)}
                        description={METRIC_INFO.wordEmission}
                      />
                      <MetricStat
                        name="Turn detection"
                        value={formatLatency(turnDetectionMs)}
                        description={METRIC_INFO.turnDetection}
                      />
                    </div>
                    <div className="flex items-center gap-1.5 border-t border-line/70 pt-4 w-full justify-center">
                      <span
                        aria-hidden="true"
                        className={`h-1.5 w-1.5 rounded-full ${
                          running
                            ? "bg-accent"
                            : starting
                              ? "bg-muted"
                              : "bg-faint"
                        }`}
                      />
                      <span className="text-[10px] uppercase tracking-[0.14em] text-faint">
                        {mode}
                      </span>
                    </div>
                  </div>
                </aside>

                <div
                  className="flex min-w-0 flex-1 flex-col gap-6"
                  aria-live="polite"
                >
                  {/* Heard strip */}
                  <motion.div
                    {...fade}
                    className="flex flex-col gap-1.5 rounded-xl border border-line bg-surface/40 px-4 py-3"
                  >
                    <StageLabel>Heard</StageLabel>
                    {heard ? (
                      <p className="text-sm leading-6 text-muted">{heard}</p>
                    ) : (
                      <p className="text-sm italic leading-6 text-faint">
                        {running
                          ? mode === "practice"
                            ? "Listening — speak the question."
                            : "Listening to the shared tab."
                          : "Connecting to transcription…"}
                      </p>
                    )}
                  </motion.div>

                  {/* Answer hero */}
                  <motion.div {...fade} className="min-h-[168px]">
                    <AnswerStage
                      answer={answer}
                      loading={answerLoading}
                      error={answerError}
                      onRetry={retryAnswer}
                      fade={fade}
                    />
                  </motion.div>

                  {/* History */}
                  <motion.div {...fade}>
                    <HistoryPanel entries={history} reducedMotion={!!reducedMotion} />
                  </motion.div>
                </div>
              </div>
            </div>
          ) : (
            /* ---------- IDLE: calm centered layout ---------- */
            <div className="mx-auto flex w-full max-w-[720px] flex-col items-center gap-8 lg:max-w-[760px] lg:gap-9">
              <header className="flex flex-col items-center gap-3 text-center">
                <h1
                  aria-label="Kluely"
                  className="flex items-center gap-3 sm:gap-3.5"
                >
                  <Image
                    src="/logo.png"
                    alt=""
                    width={120}
                    height={160}
                    loading="eager"
                    className="h-9 w-auto sm:h-11 lg:h-12"
                  />
                  <Wordmark className="h-8 w-auto sm:h-10 lg:h-11" />
                </h1>
                <p className="text-sm text-muted lg:text-base">
                  Interview coaching for Klingons.
                </p>
                {/* Mode: makes the capture scope explicit */}
                <div
                  className="mt-2.5 inline-flex items-center rounded-full border border-line bg-surface p-0.5 text-xs lg:text-sm"
                  role="group"
                  aria-label="Capture mode"
                >
                  <button
                    type="button"
                    aria-pressed={mode === "practice"}
                    onClick={() => switchMode("practice")}
                    className={`rounded-full px-3.5 py-1 transition-colors lg:px-4 ${
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
                    className={`rounded-full px-3.5 py-1 transition-colors lg:px-4 ${
                      mode === "live"
                        ? "bg-background font-medium text-foreground"
                        : "text-muted hover:text-foreground"
                    }`}
                  >
                    Live
                  </button>
                </div>
                <p className="text-xs text-faint lg:text-sm">
                  {mode === "practice"
                    ? "Uses your microphone — answering what you say."
                    : "Captures a browser tab — answering what they ask."}
                </p>
              </header>

              <div className="flex flex-col items-center gap-5">
                <div className="relative flex items-center justify-center">
                  <RecordOrb
                    variant="center"
                    running={running}
                    starting={starting}
                    onClick={toggleRecording}
                    transition={swoop}
                  />
                </div>
                <CenterWaveform levels={levels} active={running} />
              </div>

              {/* Guidance / errors */}
              <section
                aria-live="polite"
                className="flex min-h-16 w-full flex-col items-center text-center"
              >
                <AnimatePresence mode="wait">
                  {sessionError ? (
                    <motion.div key={`err-${sessionError}`} {...fade}>
                      {sessionErrorPanel}
                    </motion.div>
                  ) : (
                    <motion.div
                      key={`hint-${mode}`}
                      {...fade}
                      className="flex flex-col items-center gap-2"
                    >
                      <p className="text-sm text-muted lg:text-base">
                        Tap to start listening.
                      </p>
                      {mode === "practice" ? (
                        <p className="text-sm text-faint lg:text-base">
                          Try{" "}
                          <span className="text-muted">
                            &ldquo;Where do you see yourself in five
                            years?&rdquo;
                          </span>
                        </p>
                      ) : (
                        <p className="text-sm text-faint lg:text-base">
                          Pick the meeting tab and tick &ldquo;Also share tab
                          audio.&rdquo;
                        </p>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </section>

              {/* History persists after stopping, so it feels like memory. */}
              {history.length > 0 && (
                <motion.div {...fade} className="w-full">
                  <HistoryPanel
                    entries={history}
                    reducedMotion={!!reducedMotion}
                  />
                </motion.div>
              )}
            </div>
          )}
        </LayoutGroup>
      </main>

      {/* Persistent status bar: solid ground so scrolling content never
          shows through, full-width so it reads as app chrome rather than
          part of the text column. */}
      <footer className="fixed inset-x-0 bottom-0 border-t border-line bg-background pb-[env(safe-area-inset-bottom)]">
        {/* Stacks vertically on mobile (donation + credit in one tidy column),
            collapses to a single status-bar row from sm up. */}
        <div className="flex w-full flex-col items-center gap-1.5 px-6 py-2.5 text-xs text-muted sm:h-12 sm:flex-row sm:justify-between sm:gap-4 sm:py-0">
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${
                running ? "bg-accent" : starting ? "bg-muted" : "bg-faint"
              }`}
            />
            {mode === "practice" ? "Practice" : "Live"} · {connectionLabel}
          </span>
          <span className="flex flex-col items-center gap-1.5 sm:flex-row sm:gap-4">
            {/* Mobile-only donation: the desktop copy lives top-right. Styled
                to match the surrounding footer links rather than float. */}
            <a
              href={DONATION_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-1 text-muted transition-colors hover:text-accent focus-visible:text-accent sm:hidden"
            >
              Help Keep Cloaking Active!
              <span
                aria-hidden="true"
                className="transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
              >
                →
              </span>
            </a>
            {/* Balances the status readout on the left: credit sits flush to
                the footer's right edge on desktop, centered under the donation
                line on mobile. */}
            <a
              href="https://www.assemblyai.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted transition-colors hover:text-foreground"
            >
              Powered by AssemblyAI
            </a>
          </span>
        </div>
      </footer>
    </div>
  );
}

/** The stage's centrepiece: thinking → error → answer, with an empty prompt. */
function AnswerStage({
  answer,
  loading,
  error,
  onRetry,
  fade,
}: {
  answer: AnswerPayload | null;
  loading: boolean;
  error: AnswerError | null;
  onRetry: () => void;
  fade: object;
}) {
  return (
    <AnimatePresence mode="wait">
      {loading ? (
        <motion.div
          key="thinking"
          {...fade}
          className="flex items-center gap-2 pt-4"
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
      ) : error ? (
        <motion.div key="answer-error" {...fade}>
          {error.kind === "rate-limited" ? (
            <StatePanel
              title="The demo is popular right now"
              body="Too many questions in the last minute. Give it a few seconds — your question is saved."
              actionLabel="Retry"
              onAction={onRetry}
            />
          ) : (
            <StatePanel
              alert
              title={
                error.kind === "network"
                  ? "Couldn't reach the server"
                  : "Couldn't compose an answer"
              }
              body={
                error.kind === "network"
                  ? "The request didn't make it out. Check your connection — your question is saved."
                  : "Something went wrong while generating the Klingon. Your question is saved, so just retry."
              }
              actionLabel="Retry"
              onAction={onRetry}
            />
          )}
        </motion.div>
      ) : answer ? (
        <motion.div
          key={answer.klingon}
          {...fade}
          className="flex flex-col gap-5"
        >
          <div className="flex flex-col gap-2">
            <StageLabel>Answer</StageLabel>
            <p className="text-3xl font-semibold leading-tight tracking-tight text-foreground sm:text-4xl lg:text-5xl">
              {answer.klingon}
            </p>
          </div>
          <p className="piqad text-2xl leading-snug text-accent sm:text-3xl lg:text-4xl">
            {answer.pIqaD}
          </p>
          <p className="text-xs leading-5 text-faint">
            Literal: {answer.backTranslation}
          </p>
          <div className="flex flex-col gap-1.5 border-t border-line/60 pt-4">
            <StageLabel>Suggested (EN)</StageLabel>
            <p className="text-sm leading-6 text-muted">{answer.english}</p>
          </div>
        </motion.div>
      ) : (
        <motion.div
          key="empty"
          {...fade}
          className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line/70 py-12 text-center"
        >
          <span
            aria-hidden="true"
            className="thinking-dot h-2 w-2 rounded-full bg-accent/70"
          />
          <p className="text-sm text-faint">
            Speak a question — your Klingon answer appears here.
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Scrollable log of prior exchanges, newest on top. */
function HistoryPanel({
  entries,
  reducedMotion,
}: {
  entries: HistoryEntry[];
  reducedMotion: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <StageLabel>History</StageLabel>
        {entries.length > 0 && (
          <span className="text-[10px] tabular-nums text-faint">
            {entries.length}
          </span>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line/70 px-4 py-6 text-center text-xs text-faint">
          Previous exchanges collect here.
        </p>
      ) : (
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto pr-1">
          <AnimatePresence initial={false}>
            {entries.map((entry) => (
              <motion.div
                key={entry.id}
                initial={
                  reducedMotion ? { opacity: 0 } : { opacity: 0, y: -8 }
                }
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                className="flex flex-col gap-1 rounded-xl border border-line bg-surface/40 px-4 py-3"
              >
                <p className="text-xs leading-5 text-faint">{entry.question}</p>
                <p className="text-sm font-medium leading-6 text-foreground">
                  {entry.klingon}
                </p>
                <p className="piqad text-sm leading-6 text-accent">
                  {entry.pIqaD}
                </p>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

/** Maps a session-level error to its designed panel. */
function SessionErrorPanel({
  kind,
  onRetry,
  onUsePractice,
}: {
  kind: SessionErrorKind;
  onRetry: () => void;
  onUsePractice: () => void;
}) {
  switch (kind) {
    case "mic-denied":
      return (
        <StatePanel
          alert
          title="Microphone access is blocked"
          body="Kluely needs to hear the question. Allow microphone access for this site in your browser's address bar, then try again."
          actionLabel="Try again"
          onAction={onRetry}
        />
      );
    case "tab-audio":
      return (
        <StatePanel
          alert
          title="No tab audio was shared"
          body={
            'Pick the meeting tab in Chrome’s picker and tick "Also share tab audio" at the bottom — sharing a window or screen won’t carry sound.'
          }
          actionLabel="Share again"
          onAction={onRetry}
        />
      );
    case "unsupported":
      return (
        <StatePanel
          alert
          title="Tab capture isn't supported here"
          body="This browser can't capture tab audio. Use Chrome or Edge on desktop, or switch to Practice mode and use your microphone."
          actionLabel="Use Practice mode"
          onAction={onUsePractice}
        />
      );
    case "busy":
      return (
        <StatePanel
          title="All demo slots are in use"
          body="Kluely limits simultaneous sessions to stay inside its API budget. Slots free up within a few minutes."
          actionLabel="Try again"
          onAction={onRetry}
        />
      );
    case "connection":
      return (
        <StatePanel
          alert
          title="Connection lost"
          body="The transcription session ended unexpectedly. Check your network and start again — nothing you said was lost."
          actionLabel="Reconnect"
          onAction={onRetry}
        />
      );
  }
}

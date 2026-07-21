"use client";

// Temporary test harness for the audio → AssemblyAI streaming pipeline.
// Not the real UI — just enough to verify capture, transcription, latency,
// and the /api/answer round trip.

import { useCallback, useRef, useState } from "react";
import { AudioCapture, MicrophonePermissionError } from "@/lib/audio-capture";
import { AssemblyAIStream } from "@/lib/assemblyai-stream";

interface AnswerPayload {
  english: string;
  klingon: string;
  pIqaD: string;
  backTranslation: string;
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

export default function Home() {
  const captureRef = useRef<AudioCapture | null>(null);
  const streamRef = useRef<AssemblyAIStream | null>(null);
  const answerAbortRef = useRef<AbortController | null>(null);

  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [finals, setFinals] = useState<string[]>([]);
  const [partial, setPartial] = useState("");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [answer, setAnswer] = useState<AnswerPayload | null>(null);
  const [answerLoading, setAnswerLoading] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);

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
      const data: unknown = await res.json();
      if (!res.ok || !isAnswerPayload(data)) {
        setAnswerError("Failed to generate answer");
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
        setAnswerError("Failed to generate answer");
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
    setError(null);
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
      onError: (err) => setError(err.message),
      onSessionEnd: () => {
        // Covers server-side closes and the hidden-tab auto-terminate.
        void stopPipeline();
      },
    });
    const capture = new AudioCapture();
    streamRef.current = stream;
    captureRef.current = capture;

    try {
      await stream.start();
      await capture.start((chunk) => stream.sendAudio(chunk));
      setRunning(true);
    } catch (err) {
      if (err instanceof MicrophonePermissionError) {
        setError("Microphone access was denied — allow it and try again.");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      await stopPipeline();
    } finally {
      setStarting(false);
    }
  }, [requestAnswer, stopPipeline]);

  const handleClick = () => {
    if (running) {
      void stopPipeline();
    } else {
      void startPipeline();
    }
  };

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-8 font-sans">
      <h1 className="text-xl font-semibold">Streaming pipeline test harness</h1>

      <div className="flex items-center gap-4">
        <button
          onClick={handleClick}
          disabled={starting}
          className="rounded border px-4 py-2 disabled:opacity-50"
        >
          {starting ? "Starting…" : running ? "Stop" : "Start"}
        </button>
        <span className="text-sm">
          Latency: {latencyMs !== null ? `${latencyMs} ms` : "—"}
        </span>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="whitespace-pre-wrap text-base leading-7">
        {finals.join(" ")}
        {partial && <span className="opacity-50"> {partial}</span>}
      </div>

      <section className="flex flex-col gap-3 border-t pt-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide">
          Answer {answerLoading && <span className="font-normal">…generating</span>}
        </h2>
        {answerError && <p className="text-sm text-red-600">{answerError}</p>}
        {answer && (
          <dl className="flex flex-col gap-2 text-base leading-7">
            <div>
              <dt className="text-xs uppercase opacity-60">English</dt>
              <dd>{answer.english}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase opacity-60">Klingon</dt>
              <dd>{answer.klingon}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase opacity-60">pIqaD</dt>
              <dd>{answer.pIqaD}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase opacity-60">Back-translation</dt>
              <dd>{answer.backTranslation}</dd>
            </div>
          </dl>
        )}
      </section>
    </main>
  );
}

"use client";

// Temporary test harness for the audio → AssemblyAI streaming pipeline.
// Not the real UI — just enough to verify capture, transcription, and latency.

import { useCallback, useRef, useState } from "react";
import { AudioCapture, MicrophonePermissionError } from "@/lib/audio-capture";
import { AssemblyAIStream } from "@/lib/assemblyai-stream";

export default function Home() {
  const captureRef = useRef<AudioCapture | null>(null);
  const streamRef = useRef<AssemblyAIStream | null>(null);

  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [finals, setFinals] = useState<string[]>([]);
  const [partial, setPartial] = useState("");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

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

    const stream = new AssemblyAIStream({
      onPartialTranscript: (turn) => setPartial(turn.transcript),
      onFinalTranscript: (turn, latency) => {
        setPartial("");
        if (turn.transcript) {
          setFinals((prev) => [...prev, turn.transcript]);
        }
        setLatencyMs(latency);
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
  }, [stopPipeline]);

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
    </main>
  );
}

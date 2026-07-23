import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "How Kluely Works",
  description:
    "How Kluely turns spoken questions into validated Klingon — capture, transcription, the language-model pipeline, morphological validation, and warp drive.",
};

// The translation → validation pipeline, kept as data so the numbered list
// renders consistently. `title` is the bold lead; `body` the explanation.
const PIPELINE: { title: string; body: string }[] = [
  {
    title: "Generate answer (English).",
    body: 'Gemini writes a concise interview answer (shown as "Suggested").',
  },
  {
    title: "Simplify.",
    body: "The answer is rewritten into short, concrete statements Klingon can express.",
  },
  {
    title: "Handle missing words.",
    body: "For concepts Klingon lacks, substitute the closest real word (salmon → fish); only if none exists, transliterate phonetically as a loanword.",
  },
  {
    title: "Ground vocabulary.",
    body: "Look up verified Klingon words for each concept in the boQwI' lexicon; the model may use only those.",
  },
  {
    title: "Translate.",
    body: "Gemini composes the Klingon under a grammar reference (word order, prefixes, suffixes).",
  },
  {
    title: "Render script.",
    body: "Convert the Klingon to pIqaD via a fixed lookup table (not the model).",
  },
  {
    title: "Validate morphology.",
    body: "Parse every word with yajwiz, a Klingon morphological analyzer, to confirm validity and extract morphemes.",
  },
  {
    title: "Back-translate.",
    body: 'Build the literal English gloss ("Literal") from the yajwiz parse, not from the model re-reading its own output.',
  },
  {
    title: "Check meaning and retry.",
    body: "Compare the back-translation to the intended answer and verify possessives, subject/object agreement, and plural endings. Regenerate with a correction if wrong.",
  },
  {
    title: "Flag confidence.",
    body: "Mark the result verified, or unverified if it cannot be confirmed after retries.",
  },
];

/** Section heading — small-caps accented rule, matching the app's stage labels. */
function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-12 text-lg font-semibold tracking-tight text-foreground sm:text-xl">
      {children}
    </h2>
  );
}

export default function HowItWorksPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-5 pb-24 pt-8 sm:px-6 sm:pt-12">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-accent focus-visible:text-accent"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M10 3.5 5.5 8l4.5 4.5" />
        </svg>
        Back to Kluely
      </Link>

      <h1 className="mt-8 text-3xl font-semibold leading-tight tracking-tight text-foreground sm:text-4xl">
        How Kluely Works
      </h1>

      <SectionHeading>Audio capture and transcription</SectionHeading>
      <p className="mt-3 text-sm leading-7 text-muted">
        Kluely captures microphone audio (or, in Live mode, browser-tab audio).
        An AudioWorklet resamples it to 16&nbsp;kHz, mono, 16-bit PCM and splits
        it into 50-millisecond chunks. These stream over a WebSocket to
        AssemblyAI&apos;s Universal-Streaming API (v3 real-time model) at a
        16&nbsp;kHz sample rate. Authentication uses a temporary, single-use
        token minted server-side (expires in 60 seconds); the API key never
        reaches the browser. AssemblyAI returns transcript text as you speak and
        signals &ldquo;end of turn&rdquo; when a thought is complete.
      </p>

      <SectionHeading>Handoff to the language model</SectionHeading>
      <p className="mt-3 text-sm leading-7 text-muted">
        On end of turn, the client sends the finalized transcript to
        Kluely&apos;s own server, which passes it to Google Gemini. AssemblyAI
        and Gemini do not communicate directly; the app routes the transcript
        between them. The Gemini key also stays server-side.
      </p>

      <SectionHeading>Translation and validation pipeline</SectionHeading>
      <ol className="mt-5 flex flex-col gap-4">
        {PIPELINE.map((step, i) => (
          <li key={step.title} className="flex gap-3.5">
            <span
              aria-hidden="true"
              className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-surface font-mono text-xs tabular-nums text-accent"
            >
              {i + 1}
            </span>
            <p className="text-sm leading-7 text-muted">
              <span className="font-medium text-foreground">{step.title}</span>{" "}
              {step.body}
            </p>
          </li>
        ))}
      </ol>

      <SectionHeading>Warp drive</SectionHeading>
      <p className="mt-3 text-sm leading-7 text-muted">
        Warp drive reduces latency by skipping the expensive verification steps
        — morphological validation, meaning checks, and retries — while keeping
        vocabulary grounding and simplification. Output is faster but not
        independently validated, and is marked accordingly.
      </p>
    </main>
  );
}

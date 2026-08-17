import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The answer route reads data/klingon-lexicon.json from disk at runtime; make
  // sure the file is traced into the serverless bundle for that route.
  //
  // Likewise, the Notetaker create-bot route reads the bot's video (logo.jpg)
  // and audio (intro.mp3) from assets/notetaker at runtime to base64-encode them
  // into the Create Bot request. Node file tracing can't see these dynamic
  // fs reads, so force them into that route's bundle.
  outputFileTracingIncludes: {
    "/api/answer": ["./data/klingon-lexicon.json"],
    "/api/recall/create-bot": ["./assets/notetaker/**"],
  },
};

export default nextConfig;

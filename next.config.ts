import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The answer route reads data/klingon-lexicon.json from disk at runtime; make
  // sure the file is traced into the serverless bundle for that route.
  outputFileTracingIncludes: {
    "/api/answer": ["./data/klingon-lexicon.json"],
  },
};

export default nextConfig;

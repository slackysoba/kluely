// Server-only. Do NOT import from client components.
//
// A single ioredis connection reused across serverless invocations. Vercel
// functions don't share memory between requests, but a warm instance can be
// reused for several invocations — caching the client on globalThis avoids
// opening a new TCP connection (and leaking sockets) on every call. This is the
// ioredis path deliberately: the store speaks the RESP protocol over REDIS_URL,
// not the @vercel/kv REST SDK.
import Redis from "ioredis";

declare global {
  var __kluelyRedis: Redis | undefined;
}

function createClient(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL is not set");
  }
  const client = new Redis(url, {
    // Fail fast instead of hanging a serverless invocation on a dead socket.
    maxRetriesPerRequest: 3,
    connectTimeout: 10_000,
    // Recover transparently if a warm instance's socket was dropped between
    // invocations.
    reconnectOnError: () => true,
  });
  // Don't let a transient connection error crash the function process.
  client.on("error", (err) => {
    console.error("[redis] connection error:", err.message);
  });
  return client;
}

/** The shared ioredis client, created lazily and cached across invocations. */
export function getRedis(): Redis {
  if (!global.__kluelyRedis) {
    global.__kluelyRedis = createClient();
  }
  return global.__kluelyRedis;
}

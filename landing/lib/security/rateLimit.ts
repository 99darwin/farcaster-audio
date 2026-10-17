/**
 * In-memory fixed-window rate limiter for Next.js route handlers.
 *
 * State lives in the serverless instance's memory, so the effective ceiling
 * is per instance, not global. That is enough to blunt a single client
 * hammering a route; the authoritative limits live in the backend (Redis).
 */

export interface FixedWindowLimiterOptions {
  /** Requests allowed per key per window. */
  limit: number;
  windowMs: number;
  /** Bound on tracked keys so a spray of distinct IPs can't grow memory. */
  maxKeys: number;
}

export interface FixedWindowLimiter {
  /** Counts one request for `key`; false once it is over the limit. */
  isAllowed(key: string, nowMs?: number): boolean;
}

interface Bucket {
  count: number;
  resetAtMs: number;
}

export function createFixedWindowLimiter({
  limit,
  windowMs,
  maxKeys,
}: FixedWindowLimiterOptions): FixedWindowLimiter {
  const buckets = new Map<string, Bucket>();

  function evictExpired(nowMs: number): void {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAtMs <= nowMs) buckets.delete(key);
    }
  }

  return {
    isAllowed(key: string, nowMs: number = Date.now()): boolean {
      const existing = buckets.get(key);
      if (existing && existing.resetAtMs > nowMs) {
        existing.count += 1;
        return existing.count <= limit;
      }
      if (buckets.size >= maxKeys) {
        evictExpired(nowMs);
        // Still full of live buckets: drop the oldest-inserted one.
        if (buckets.size >= maxKeys) {
          const oldest = buckets.keys().next().value;
          if (oldest !== undefined) buckets.delete(oldest);
        }
      }
      buckets.delete(key);
      buckets.set(key, { count: 1, resetAtMs: nowMs + windowMs });
      return limit >= 1;
    },
  };
}

/**
 * Client IP as reported by Vercel's edge, which overwrites `x-real-ip` and
 * `x-forwarded-for` with the connecting address (clients can't spoof them).
 */
export function clientIpFromHeaders(headers: Headers): string {
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const forwardedFor = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || "unknown";
}

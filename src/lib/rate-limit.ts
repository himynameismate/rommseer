import { NextRequest, NextResponse } from "next/server";

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

/**
 * Simple in-memory rate limiter.
 * Tracks request counts per key (typically IP) within a sliding window.
 */
class RateLimiter {
  private store = new Map<string, RateLimitEntry>();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /**
   * Check if a request should be allowed.
   * @returns true if the request is allowed, false if rate-limited.
   */
  check(key: string): boolean {
    const now = Date.now();
    const entry = this.store.get(key);

    if (!entry || now > entry.resetTime) {
      this.store.set(key, { count: 1, resetTime: now + this.windowMs });
      return true;
    }

    entry.count++;
    if (entry.count > this.maxRequests) {
      return false;
    }

    return true;
  }

  /** Periodically clean up expired entries to prevent memory leaks. */
  cleanup(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];
    this.store.forEach((entry, key) => {
      if (now > entry.resetTime) {
        keysToDelete.push(key);
      }
    });
    keysToDelete.forEach((key) => this.store.delete(key));
  }
}

// Shared limiter instances
const limiters = new Map<string, RateLimiter>();

// Run cleanup every 5 minutes
setInterval(() => {
  limiters.forEach((limiter) => {
    limiter.cleanup();
  });
}, 5 * 60 * 1000).unref?.();

/**
 * Get or create a rate limiter by name.
 * @param name - Unique identifier for this limiter
 * @param maxRequests - Max requests allowed in the window (default: 30)
 * @param windowMs - Window duration in milliseconds (default: 60000 = 1 minute)
 */
export function getRateLimiter(
  name: string,
  maxRequests = 30,
  windowMs = 60_000
): RateLimiter {
  let limiter = limiters.get(name);
  if (!limiter) {
    limiter = new RateLimiter(maxRequests, windowMs);
    limiters.set(name, limiter);
  }
  return limiter;
}

/**
 * Extract an identifier for rate limiting from the request.
 * Only trusts x-forwarded-for/x-real-ip headers when TRUST_PROXY=true,
 * preventing clients from spoofing their IP to bypass rate limits.
 */
export function getClientIp(req: NextRequest): string {
  if (process.env.TRUST_PROXY === "true") {
    const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  return req.headers.get("x-real-ip") || "unknown";
}

/**
 * Apply rate limiting to a request. Returns a 429 response if limited, or null if allowed.
 */
export function applyRateLimit(
  req: NextRequest,
  limiterName: string,
  maxRequests = 30,
  windowMs = 60_000
): NextResponse | null {
  const limiter = getRateLimiter(limiterName, maxRequests, windowMs);
  const ip = getClientIp(req);

  if (!limiter.check(ip)) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  return null;
}

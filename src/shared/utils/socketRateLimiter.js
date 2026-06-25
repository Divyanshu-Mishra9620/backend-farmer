/**
 * Lightweight in-memory sliding-window rate limiter for Socket.IO events.
 * Mirrors the express-rate-limit tiers used for the REST API (general vs AI),
 * since socket events bypass express middleware entirely.
 */
export function createSocketRateLimiter({ windowMs, max }) {
  const hits = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now > entry.resetAt) hits.delete(key);
    }
  }, windowMs).unref?.();

  return function check(key) {
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true };
    }

    if (entry.count >= max) {
      return {
        allowed: false,
        retryAfterMs: entry.resetAt - now,
      };
    }

    entry.count += 1;
    return { allowed: true };
  };
}

// AI-cost events: chat_message, analyze_soil - same spirit as REST aiLimiter
export const checkAiSocketLimit = createSocketRateLimiter({
  windowMs: 60 * 1000,
  max: 8,
});

// General socket actions: community messages, reactions, channel membership
export const checkGeneralSocketLimit = createSocketRateLimiter({
  windowMs: 60 * 1000,
  max: 40,
});

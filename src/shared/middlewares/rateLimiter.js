import rateLimit, { ipKeyGenerator } from "express-rate-limit";

export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message:
      "Too many requests from this IP. Please try again after 15 minutes.",
    retryAfter: "15 minutes",
  },
  keyGenerator: (req) => {
    return req.user?.id || ipKeyGenerator(req.ip);
  },
});

export const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message:
      "AI request limit reached. Please wait before sending more queries.",
    retryAfter: "15 minutes",
  },
  keyGenerator: (req) => {
    return `ai:${req.user?.id || ipKeyGenerator(req.ip)}`;
  },
});

export const streamLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Streaming request limit reached. Please wait before trying again.",
    retryAfter: "15 minutes",
  },
  keyGenerator: (req) => {
    return `stream:${req.user?.id || ipKeyGenerator(req.ip)}`;
  },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many login attempts. Please try again after 15 minutes.",
    retryAfter: "15 minutes",
  },
});

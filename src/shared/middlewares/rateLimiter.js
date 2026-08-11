import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import httpError from "../utils/httpError.js";

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

// Field hardware is limited per device, not per IP: an entire plot of nodes
// shares one hotspot's NAT address, so IP keying would let one chatty gateway
// throttle every other node on the same uplink.
//
// That only works if these are mounted AFTER deviceAuth in the route chain.
// express-rate-limit computes the key before the handler runs, so with the
// conventional limiter-first ordering req.device is still undefined and every
// device silently collapses into the shared IP bucket the keying exists to
// avoid. See the ordering (and its comment) in telemetry.routes.js.
//
// These two use `handler` rather than the `message` object the limiters above
// use, because API_CONTRACT.md §5 requires device-facing failures to come back
// in the standard {success,error:{code,message}} envelope — routing through
// httpError is what produces RATE_LIMIT_EXCEEDED via the central errorHandler.
export const deviceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `device:${req.device?.id || ipKeyGenerator(req.ip)}`,
  handler: (req, res, next) =>
    next(
      httpError(
        429,
        "Device reporting limit reached. Increase the reading interval."
      )
    ),
});

export const deviceUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    `device-upload:${req.device?.id || ipKeyGenerator(req.ip)}`,
  handler: (req, res, next) =>
    next(
      httpError(
        429,
        "Device upload limit reached. Increase the capture interval."
      )
    ),
});

import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import httpError from "../utils/httpError.js";

// The four routes a field device calls with its X-Device-Key. They have their
// own limiters (deviceLimiter / deviceUploadLimiter, keyed by device id, and
// deviceAuthFailLimiter below), so the shared 100-per-15-min bucket must not
// also apply: that bucket is keyed by IP, and a farm router puts the gateway
// (a reading every minute, plus config polls and command acks) and the owner's
// phone on the same address. The gateway would starve the app, or the reverse.
const DEVICE_ROUTES = [
  ["POST", /^\/telemetry\/readings\/?$/],
  ["POST", /^\/telemetry\/captures\/?$/],
  ["GET", /^\/telemetry\/config\/?$/],
  ["POST", /^\/telemetry\/commands\/[^/]+\/ack\/?$/],
];

export const isDeviceRequest = (req) => {
  if (typeof req.headers?.["x-device-key"] !== "string") return false;
  // Mounted at /api, so req.path is relative to that mount.
  const path = req.path || "";
  return DEVICE_ROUTES.some(
    ([method, pattern]) => req.method === method && pattern.test(path)
  );
};

export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: isDeviceRequest,
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

// Placed in front of deviceAuth. It only counts requests that came back 401
// (missing / malformed / unknown key), so a device with a valid key is never
// penalised here, but something guessing keys from one address is cut off
// instead of costing a database lookup per attempt. The bucket is per address,
// so a device with a rotated or mistyped key (one failure per report interval)
// uses a small share of it; the cap is far above that and far below anything
// useful for guessing a 192-bit key.
export const deviceAuthFailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => res.statusCode !== 401,
  keyGenerator: (req) => `device-auth-fail:${ipKeyGenerator(req.ip)}`,
  handler: (req, res, next) =>
    next(httpError(429, "Too many failed device authentications. Try again later.")),
});

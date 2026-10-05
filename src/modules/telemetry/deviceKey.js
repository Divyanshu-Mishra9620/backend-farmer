import crypto from "crypto";
import config from "../../config/env.js";

const KEY_LABEL = "knd_";
const KEY_BYTES = 24;
const PREFIX_CHARS = 12;

export const DEVICE_KEY_PATTERN = /^knd_[0-9a-f]{48}$/;

export function hashDeviceKey(key) {
  const hasher = config.deviceKeyPepper
    ? crypto.createHmac("sha256", config.deviceKeyPepper)
    : crypto.createHash("sha256");
  return hasher.update(key).digest("hex");
}

export function generateDeviceKey() {
  const key = `${KEY_LABEL}${crypto.randomBytes(KEY_BYTES).toString("hex")}`;

  return {
    key,
    keyHash: hashDeviceKey(key),
    keyPrefix: key.slice(0, PREFIX_CHARS),
  };
}

export function verifyDeviceKey(key, keyHash) {
  const candidate = Buffer.from(hashDeviceKey(key), "utf8");
  const stored = Buffer.from(typeof keyHash === "string" ? keyHash : "", "utf8");

  if (candidate.length !== stored.length) return false;

  return crypto.timingSafeEqual(candidate, stored);
}

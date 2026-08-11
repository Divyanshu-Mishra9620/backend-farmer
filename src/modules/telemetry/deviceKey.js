import crypto from "crypto";
import config from "../../config/env.js";

const KEY_LABEL = "knd_";
// 24 random bytes render as the 48 lowercase hex characters the contract
// specifies. Do not shorten this: the hash below has no work factor, so the
// entropy of the key is the entire defence.
const KEY_BYTES = 24;
const PREFIX_CHARS = 12;

export const DEVICE_KEY_PATTERN = /^knd_[0-9a-f]{48}$/;

// A plain digest rather than bcrypt/argon2, deliberately. What is being hashed
// is 192 bits of CSPRNG output, so there is no dictionary to slow down and a
// work factor would buy nothing. What it does buy is determinism: deviceAuth
// can resolve a key with one indexed findOne on keyHash instead of loading
// every device in the database and comparing hashes in a loop, which is what a
// per-row salt would force onto the critical path of every single ingest.
// The price is that DEVICE_KEY_PEPPER is baked into stored hashes — setting,
// changing or removing it on a live deployment orphans every issued key, and
// each board then has to be re-registered or rotated.
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

  // timingSafeEqual throws rather than returning false on a length mismatch,
  // so lengths have to be checked first. Leaking that comparison is harmless —
  // both sides are fixed-width sha256 hex whenever the record is well-formed.
  if (candidate.length !== stored.length) return false;

  return crypto.timingSafeEqual(candidate, stored);
}

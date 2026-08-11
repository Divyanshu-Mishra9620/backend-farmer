import Device from "./device.model.js";
import {
  DEVICE_KEY_PATTERN,
  hashDeviceKey,
  verifyDeviceKey,
} from "./deviceKey.js";
import httpError from "../../shared/utils/httpError.js";
import { createLogger } from "../../shared/utils/logger.js";

const logger = createLogger("DeviceAuth");

export const deviceAuth = async (req, res, next) => {
  try {
    const presentedKey = req.headers["x-device-key"];

    if (!presentedKey || typeof presentedKey !== "string") {
      throw httpError(401, "Device key required");
    }

    // A malformed key gets the same 401 as a wrong one so the response can't
    // be used to discover what a valid key looks like, and so a junk header
    // never reaches the database.
    if (!DEVICE_KEY_PATTERN.test(presentedKey)) {
      throw httpError(401, "Invalid device key");
    }

    const device = await Device.findOne({
      keyHash: hashDeviceKey(presentedKey),
    }).select("+keyHash");

    // The findOne already matched on the full hash, so this re-check is belt
    // and braces. It is constant-time anyway because the contract promises
    // that, and because if the lookup is ever narrowed to keyPrefix (which is
    // not unique) this comparison becomes the thing standing between a
    // guessed prefix and a valid session.
    if (!device || !verifyDeviceKey(presentedKey, device.keyHash)) {
      throw httpError(401, "Invalid device key");
    }

    if (!device.isActive) {
      throw httpError(403, "Device is deactivated");
    }

    req.device = device;
    req.deviceOwner = device.owner;

    // Presence bookkeeping, not something the response depends on. Awaiting it
    // would put a write round-trip in front of every reading a battery-powered
    // node sends, and holding a TLS socket open for a lastSeenAt write is
    // exactly the kind of stall that drains a field battery. The .catch() is
    // mandatory, not decorative: an unhandled rejection here takes the whole
    // process down under Node's default --unhandled-rejections=throw.
    Device.updateOne(
      { _id: device._id },
      { $set: { lastSeenAt: new Date() } }
    ).catch((err) =>
      logger.warn(`lastSeenAt update failed for device ${device._id}`, {
        error: err.message,
      })
    );

    next();
  } catch (err) {
    next(err);
  }
};

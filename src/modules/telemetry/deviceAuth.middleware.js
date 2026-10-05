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

    if (!DEVICE_KEY_PATTERN.test(presentedKey)) {
      throw httpError(401, "Invalid device key");
    }

    const device = await Device.findOne({
      keyHash: hashDeviceKey(presentedKey),
    }).select("+keyHash");

    if (!device || !verifyDeviceKey(presentedKey, device.keyHash)) {
      throw httpError(401, "Invalid device key");
    }

    if (!device.isActive) {
      throw httpError(403, "Device is deactivated");
    }

    req.device = device;
    req.deviceOwner = device.owner;

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

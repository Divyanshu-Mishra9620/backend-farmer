import Device from "./device.model.js";
import TelemetryReading from "./telemetry.model.js";
import DeviceCapture from "./capture.model.js";
import { generateDeviceKey } from "./deviceKey.js";
import config from "../../config/env.js";
import httpError from "../../shared/utils/httpError.js";

const KEY_WARNING = "Copy this key now — it is not shown again.";

export const isDeviceOnline = (device) =>
  device.isOnlineWithin
    ? device.isOnlineWithin(config.deviceOfflineAfterS)
    : Boolean(
        device.lastSeenAt &&
          Date.now() - new Date(device.lastSeenAt).getTime() <
            config.deviceOfflineAfterS * 1000
      );

// keyHash is select:false so it is already absent from a normal query, but
// registration and rotation hold a freshly built document that does have it in
// memory — hand-picking fields here is what guarantees it can never ride out
// in a response by accident.
export const serializeDevice = (device) => ({
  id: device._id,
  name: device.name,
  nodeLabel: device.nodeLabel,
  type: device.type,
  keyPrefix: device.keyPrefix,
  plot: device.plot,
  crop: device.crop,
  location: device.location,
  isActive: device.isActive,
  online: isDeviceOnline(device),
  lastSeenAt: device.lastSeenAt,
  lastRssi: device.lastRssi,
  lastBatteryMv: device.lastBatteryMv,
  firmwareVersion: device.firmwareVersion,
  config: device.config,
  thresholds: device.thresholds,
  actuators: device.actuators,
  createdAt: device.createdAt,
  updatedAt: device.updatedAt,
});

// Rides along on every ingest response as well as GET /config, so the gateway
// picks up an interval change on its next report instead of needing a poll.
export const serializeDeviceConfig = (device) => ({
  readingIntervalS: device.config?.readingIntervalS,
  captureIntervalS: device.config?.captureIntervalS,
  captureEnabled: device.config?.captureEnabled,
});

// The {owner, nodeLabel} unique index is what actually prevents a duplicate
// label under a concurrent double-submit; translate its raw E11000 into the
// 409 the contract promises instead of letting it surface as a 500.
function rethrowDuplicateLabel(err) {
  if (err.code === 11000) {
    throw httpError(409, "A device with this node label already exists");
  }
  throw err;
}

// Every lookup below matches on _id AND owner and 404s on a miss, including
// when the id belongs to somebody else's device. A 403 for "exists but not
// yours" would turn these endpoints into an oracle for probing which device
// ids are real.
async function findOwnedDevice(ownerId, deviceId) {
  const device = await Device.findOne({ _id: deviceId, owner: ownerId });
  if (!device) throw httpError(404, "Device not found");
  return device;
}

// Applies only the keys the caller actually sent, as dotted paths, so patching
// one nested field ({ config: { captureEnabled: false } }) does not reset its
// siblings to their schema defaults the way assigning the whole subdocument
// would.
function applyNested(update, prefix, source, keys) {
  if (!source || typeof source !== "object") return;
  for (const key of keys) {
    if (source[key] !== undefined) update[`${prefix}.${key}`] = source[key];
  }
}

export const registerDevice = async (ownerId, payload) => {
  const { key, keyHash, keyPrefix } = generateDeviceKey();

  let device;
  try {
    device = await Device.create({
      owner: ownerId,
      name: payload.name,
      nodeLabel: payload.nodeLabel,
      type: payload.type || "sensor",
      plot: payload.plot,
      crop: payload.crop,
      location: payload.location,
      keyHash,
      keyPrefix,
    });
  } catch (err) {
    rethrowDuplicateLabel(err);
  }

  return { device: serializeDevice(device), deviceKey: key, warning: KEY_WARNING };
};

export const listDevices = async (ownerId) => {
  const devices = await Device.find({ owner: ownerId }).sort({ nodeLabel: 1 });
  return devices.map(serializeDevice);
};

export const updateDevice = async (ownerId, deviceId, payload) => {
  const update = {};

  for (const field of ["name", "nodeLabel", "type", "plot", "crop", "isActive"]) {
    if (payload[field] !== undefined) update[field] = payload[field];
  }

  applyNested(update, "location", payload.location, [
    "latitude",
    "longitude",
    "district",
    "state",
  ]);
  applyNested(update, "config", payload.config, [
    "readingIntervalS",
    "captureIntervalS",
    "captureEnabled",
  ]);
  applyNested(update, "thresholds", payload.thresholds, [
    "soilDryPct",
    "soilSaturatedPct",
    "heatStressC",
    "frostRiskC",
    "batteryLowMv",
  ]);
  applyNested(update, "actuators", payload.actuators, [
    "sprinklerEnabled",
    "maxRuntimeS",
    "cooldownS",
    "dailyBudgetS",
  ]);

  if (Object.keys(update).length === 0) {
    throw httpError(400, "No updatable fields were provided");
  }

  let device;
  try {
    device = await Device.findOneAndUpdate(
      { _id: deviceId, owner: ownerId },
      { $set: update },
      { new: true, runValidators: true }
    );
  } catch (err) {
    rethrowDuplicateLabel(err);
  }

  if (!device) throw httpError(404, "Device not found");
  return serializeDevice(device);
};

export const rotateKey = async (ownerId, deviceId) => {
  const { key, keyHash, keyPrefix } = generateDeviceKey();

  // Overwriting the hash is the revocation — the old key stops resolving on
  // the very next request, so a board that has not been reflashed yet starts
  // getting 401s immediately rather than running on borrowed time.
  const device = await Device.findOneAndUpdate(
    { _id: deviceId, owner: ownerId },
    { $set: { keyHash, keyPrefix } },
    { new: true }
  );

  if (!device) throw httpError(404, "Device not found");

  return { device: serializeDevice(device), deviceKey: key, warning: KEY_WARNING };
};

export const deleteDevice = async (ownerId, deviceId) => {
  const device = await findOwnedDevice(ownerId, deviceId);
  await device.deleteOne();

  // Readings and captures go with it rather than waiting on the TTL index: the
  // TTL only covers readings, and orphaned captures would keep showing up in
  // the captures feed pointing at a device that no longer resolves. The linked
  // Analysis documents are deliberately left alone — they are also the user's
  // disease-detection history and deleting a node should not erase past
  // diagnoses.
  await Promise.all([
    TelemetryReading.deleteMany({ device: device._id }),
    DeviceCapture.deleteMany({ device: device._id }),
  ]);

  return { message: "Device deleted successfully" };
};

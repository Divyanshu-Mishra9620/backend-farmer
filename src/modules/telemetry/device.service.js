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

export const normalizeNodeLabel = (raw) =>
  typeof raw === "string" && raw.trim()
    ? raw.trim().toLowerCase().slice(0, 15)
    : null;

// A gateway authenticates with ONE device key but forwards traffic for every
// leaf node behind it, tagging each reading / frame with the leaf's nodeLabel.
// This maps those labels onto the owner's registered non-gateway devices, so a
// reading from "plot-a-soil" lands on the "plot-a-soil" device (its tile, its
// history, its online status, its thresholds) instead of piling up on the
// gateway's own record.
//
// Only a device of type "gateway" may speak for other devices, and only for
// devices of the same owner, and never for another gateway. A label that matches
// nothing simply is not in the returned map; callers then fall back to the
// authenticated device, which is the behaviour before leaf devices existed.
export const resolveNodeDevices = async (gateway, labels) => {
  if (!gateway || gateway.type !== "gateway") return new Map();

  const wanted = [
    ...new Set(
      (labels || []).filter((label) => label && label !== gateway.nodeLabel)
    ),
  ];
  if (wanted.length === 0) return new Map();

  const found = await Device.find({
    owner: gateway.owner,
    nodeLabel: { $in: wanted },
    type: { $ne: "gateway" },
  });

  return new Map(found.map((device) => [device.nodeLabel, device]));
};

export const serializeDeviceConfig = (device) => ({
  readingIntervalS: device.config?.readingIntervalS,
  captureIntervalS: device.config?.captureIntervalS,
  captureEnabled: device.config?.captureEnabled,
});

function rethrowDuplicateLabel(err) {
  if (err.code === 11000) {
    throw httpError(409, "A device with this node label already exists");
  }
  throw err;
}

async function findOwnedDevice(ownerId, deviceId) {
  const device = await Device.findOne({ _id: deviceId, owner: ownerId });
  if (!device) throw httpError(404, "Device not found");
  return device;
}

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

  await Promise.all([
    TelemetryReading.deleteMany({ device: device._id }),
    DeviceCapture.deleteMany({ device: device._id }),
  ]);

  return { message: "Device deleted successfully" };
};

import mongoose from "mongoose";
import TelemetryReading from "./telemetry.model.js";
import Device from "./device.model.js";
import User from "../user/user.model.js";
import {
  isDeviceOnline,
  normalizeNodeLabel,
  resolveNodeDevices,
  serializeDevice,
} from "./device.service.js";
import { emitToUser } from "../chat/socket.js";
import { sendPushToUser } from "../../shared/utils/pushSender.js";
import config from "../../config/env.js";
import { createLogger } from "../../shared/utils/logger.js";

const logger = createLogger("Telemetry");

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_READING_LIMIT = 200;

export const clampToServerTime = (raw, now = new Date()) => {
  if (!raw) return now;

  const parsed = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(parsed.getTime())) return now;
  if (parsed.getTime() > now.getTime()) return now;
  if (now.getTime() - parsed.getTime() > DAY_MS) return now;

  return parsed;
};

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toBooleanOrNull = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === 1) return true;
  if (value === "false" || value === "0" || value === 0) return false;
  return null;
};

const serializeReading = (reading) => ({
  id: reading._id,
  deviceId: reading.device,
  nodeLabel: reading.nodeLabel,
  soilMoisturePct: reading.soilMoisturePct,
  soilRaw: reading.soilRaw,
  temperatureC: reading.temperatureC,
  humidityPct: reading.humidityPct,
  lux: reading.lux,
  rainDetected: reading.rainDetected,
  batteryMv: reading.batteryMv,
  rssi: reading.rssi,
  uptimeS: reading.uptimeS,
  recordedAt: reading.recordedAt,
  receivedAt: reading.receivedAt,
});

const round1 = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 10) / 10
    : null;

const buildAlert = (device, reading, kind, level, message, value, threshold) => ({
  deviceId: device._id,
  nodeLabel: reading.nodeLabel || device.nodeLabel,
  level,
  kind,
  message,
  value,
  threshold,
  at: reading.recordedAt,
});

export const evaluateAlerts = (device, reading) => {
  const limits = device.thresholds || {};
  const alerts = [];
  const label = reading.nodeLabel || device.nodeLabel;

  if (reading.soilMoisturePct !== null && reading.soilMoisturePct !== undefined) {
    if (reading.soilMoisturePct <= limits.soilDryPct) {
      const level =
        reading.soilMoisturePct <= limits.soilDryPct / 2 ? "critical" : "warning";
      alerts.push(
        buildAlert(
          device,
          reading,
          "soil_dry",
          level,
          `Soil moisture at ${label} is ${round1(reading.soilMoisturePct)}%, below the ${limits.soilDryPct}% irrigation threshold`,
          reading.soilMoisturePct,
          limits.soilDryPct
        )
      );
    } else if (reading.soilMoisturePct >= limits.soilSaturatedPct) {
      alerts.push(
        buildAlert(
          device,
          reading,
          "soil_saturated",
          "warning",
          `Soil at ${label} is waterlogged at ${round1(reading.soilMoisturePct)}%, check drainage before root rot sets in`,
          reading.soilMoisturePct,
          limits.soilSaturatedPct
        )
      );
    }
  }

  if (reading.temperatureC !== null && reading.temperatureC !== undefined) {
    if (reading.temperatureC >= limits.heatStressC) {
      const level =
        reading.temperatureC >= limits.heatStressC + 5 ? "critical" : "warning";
      alerts.push(
        buildAlert(
          device,
          reading,
          "heat_stress",
          level,
          `${round1(reading.temperatureC)}°C at ${label} is above the ${limits.heatStressC}°C heat-stress threshold`,
          reading.temperatureC,
          limits.heatStressC
        )
      );
    } else if (reading.temperatureC <= limits.frostRiskC) {
      alerts.push(
        buildAlert(
          device,
          reading,
          "frost_risk",
          "critical",
          `${round1(reading.temperatureC)}°C at ${label} risks frost damage tonight, cover or irrigate`,
          reading.temperatureC,
          limits.frostRiskC
        )
      );
    }
  }

  if (
    reading.batteryMv !== null &&
    reading.batteryMv !== undefined &&
    reading.batteryMv <= limits.batteryLowMv
  ) {
    const level =
      reading.batteryMv <= limits.batteryLowMv - 200 ? "critical" : "warning";
    alerts.push(
      buildAlert(
        device,
        reading,
        "battery_low",
        level,
        `Battery on ${label} is at ${reading.batteryMv} mV, below the ${limits.batteryLowMv} mV replacement threshold`,
        reading.batteryMv,
        limits.batteryLowMv
      )
    );
  }

  return alerts;
};

export async function pushDeviceAlertIfDue(device, alert) {
  try {
    const cooldownField = `lastAlertPushedAt.${alert.kind}`;
    const cutoff = new Date(Date.now() - config.telemetryAlertPushCooldownS * 1000);

    const claimed = await Device.findOneAndUpdate(
      {
        _id: device._id,
        $or: [
          { [cooldownField]: { $exists: false } },
          { [cooldownField]: null },
          { [cooldownField]: { $lte: cutoff } },
        ],
      },
      { $set: { [cooldownField]: new Date() } },
    );
    if (!claimed) return;

    const user = await User.findById(device.owner).select("pushToken");
    if (!user?.pushToken) return;

    await sendPushToUser(user.pushToken, {
      title: alert.level === "critical" ? "Critical field alert" : "Field alert",
      body: alert.message,
      data: { url: "krishiapp://field-devices", deviceId: String(device._id) },
    });
  } catch (err) {
    logger.error(`Alert push failed for device ${device._id}`, err.message);
  }
}

const deviceSummaryOf = (device) => ({
  id: device._id,
  name: device.name,
  nodeLabel: device.nodeLabel,
  type: device.type,
});

export const ingestReadings = async (device, readings) => {
  const now = new Date();
  const incoming = Array.isArray(readings) ? readings : [];

  const batch = incoming.slice(0, config.telemetryMaxBatch);
  let rejected = incoming.length - batch.length;

  const accepted = [];
  for (const raw of batch) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      rejected += 1;
      continue;
    }
    accepted.push(raw);
  }

  // The device whose key signed this request is the gateway; the readings in it
  // belong to whichever leaf node's nodeLabel they carry, when that leaf is
  // registered. Anything unmatched stays on the authenticated device.
  const leaves = await resolveNodeDevices(
    device,
    accepted.map((raw) => normalizeNodeLabel(raw.nodeLabel))
  );
  const devicesById = new Map([[String(device._id), device]]);

  const documents = [];
  for (const raw of accepted) {
    const label = normalizeNodeLabel(raw.nodeLabel);
    const target = (label && leaves.get(label)) || device;

    if (target.isActive === false) {
      rejected += 1;
      continue;
    }
    devicesById.set(String(target._id), target);

    documents.push({
      device: target._id,
      owner: device.owner,
      nodeLabel: label || device.nodeLabel,
      soilMoisturePct: toNumberOrNull(raw.soilMoisturePct),
      soilRaw: toNumberOrNull(raw.soilRaw),
      temperatureC: toNumberOrNull(raw.temperatureC),
      humidityPct: toNumberOrNull(raw.humidityPct),
      lux: toNumberOrNull(raw.lux),
      rainDetected: toBooleanOrNull(raw.rainDetected),
      batteryMv: toNumberOrNull(raw.batteryMv),
      rssi: toNumberOrNull(raw.rssi),
      uptimeS: toNumberOrNull(raw.uptimeS),
      recordedAt: clampToServerTime(raw.recordedAt, now),
      receivedAt: now,
    });
  }

  if (documents.length === 0) {
    return { accepted: 0, rejected };
  }

  let inserted = [];
  try {
    inserted = await TelemetryReading.insertMany(documents, { ordered: false });
  } catch (err) {
    inserted = err.insertedDocs || [];
    rejected += documents.length - inserted.length;
    logger.warn(`Partial telemetry insert for device ${device._id}`, {
      error: err.message,
      inserted: inserted.length,
    });
  }

  if (inserted.length === 0) {
    return { accepted: 0, rejected };
  }

  const ownerRoom = String(device.owner);

  const insertedByDevice = new Map();
  for (const reading of inserted) {
    const key = String(reading.device);
    if (!insertedByDevice.has(key)) insertedByDevice.set(key, []);
    insertedByDevice.get(key).push(reading);
  }

  for (const [key, rows] of insertedByDevice) {
    const target = devicesById.get(key) || device;

    const newest = rows.reduce((latest, reading) =>
      reading.recordedAt > latest.recordedAt ? reading : latest
    );

    const deviceUpdate = { lastSeenAt: now };
    if (newest.rssi !== null) deviceUpdate.lastRssi = newest.rssi;
    if (newest.batteryMv !== null) deviceUpdate.lastBatteryMv = newest.batteryMv;
    await Device.updateOne({ _id: target._id }, { $set: deviceUpdate });

    const deviceSummary = deviceSummaryOf(target);
    for (const reading of rows) {
      emitToUser(ownerRoom, "telemetry_reading", {
        deviceId: target._id,
        device: deviceSummary,
        reading: serializeReading(reading),
      });
    }

    emitToUser(ownerRoom, "device_status", {
      deviceId: target._id,
      nodeLabel: target.nodeLabel,
      online: true,
      lastSeenAt: now,
      batteryMv: newest.batteryMv,
    });

    for (const alert of evaluateAlerts(target, newest)) {
      emitToUser(ownerRoom, "telemetry_alert", alert);
      pushDeviceAlertIfDue(target, alert);
    }
  }

  // The gateway reported in even if every reading in the batch belonged to a
  // leaf, so keep its own card live too. (deviceAuth has already stamped its
  // lastSeenAt; this only tells the open dashboard.)
  if (!insertedByDevice.has(String(device._id))) {
    emitToUser(ownerRoom, "device_status", {
      deviceId: device._id,
      nodeLabel: device.nodeLabel,
      online: true,
      lastSeenAt: now,
      batteryMv: device.lastBatteryMv ?? null,
    });
  }

  return { accepted: inserted.length, rejected };
};

export const listReadings = async (ownerId, options = {}) => {
  const { deviceId, since, until } = options;

  const query = { owner: ownerId };
  if (deviceId) query.device = deviceId;

  if (since || until) {
    query.recordedAt = {};
    if (since) query.recordedAt.$gte = since;
    if (until) query.recordedAt.$lte = until;
  }

  const limit = Math.min(
    Math.max(parseInt(options.limit, 10) || 100, 1),
    MAX_READING_LIMIT
  );

  const readings = await TelemetryReading.find(query)
    .sort({ recordedAt: -1 })
    .limit(limit);

  return { readings: readings.map(serializeReading), limit };
};

async function latestReadingsByDevice(ownerId) {
  const latest = await TelemetryReading.aggregate([
    { $match: { owner: new mongoose.Types.ObjectId(String(ownerId)) } },
    { $sort: { recordedAt: -1 } },
    { $group: { _id: "$device", reading: { $first: "$$ROOT" } } },
  ]);

  return new Map(latest.map((row) => [String(row._id), row.reading]));
}

export const latestPerDevice = async (ownerId) => {
  const devices = await Device.find({ owner: ownerId }).sort({ nodeLabel: 1 });
  if (devices.length === 0) return [];

  const byDevice = await latestReadingsByDevice(ownerId);

  return devices.map((device) => {
    const reading = byDevice.get(String(device._id));
    return {
      device: serializeDevice(device),
      reading: reading ? serializeReading(reading) : null,
    };
  });
};

export const summary = async (ownerId) => {
  const since = new Date(Date.now() - DAY_MS);

  const [devices, aggregate] = await Promise.all([
    Device.find({ owner: ownerId }),
    TelemetryReading.aggregate([
      {
        $match: {
          owner: new mongoose.Types.ObjectId(String(ownerId)),
          recordedAt: { $gte: since },
        },
      },
      {
        $group: {
          _id: null,
          readings: { $sum: 1 },
          avgSoilMoisturePct: { $avg: "$soilMoisturePct" },
          minSoilMoisturePct: { $min: "$soilMoisturePct" },
          avgTemperatureC: { $avg: "$temperatureC" },
          minTemperatureC: { $min: "$temperatureC" },
          maxTemperatureC: { $max: "$temperatureC" },
          avgHumidityPct: { $avg: "$humidityPct" },
          minBatteryMv: { $min: "$batteryMv" },
          rainReadings: {
            $sum: { $cond: [{ $eq: ["$rainDetected", true] }, 1, 0] },
          },
        },
      },
    ]),
  ]);

  const totals = aggregate[0] || {};

  const byType = { sensor: 0, camera: 0, gateway: 0 };
  let online = 0;
  const offlineDevices = [];

  for (const device of devices) {
    byType[device.type] = (byType[device.type] || 0) + 1;
    if (isDeviceOnline(device)) {
      online += 1;
    } else if (device.isActive) {
      offlineDevices.push(device);
    }
  }

  const byDevice = await latestReadingsByDevice(ownerId);

  const alerts = [];
  for (const device of devices) {
    const reading = byDevice.get(String(device._id));
    if (reading) alerts.push(...evaluateAlerts(device, reading));
  }

  for (const device of offlineDevices) {
    alerts.push({
      deviceId: device._id,
      nodeLabel: device.nodeLabel,
      level: "warning",
      kind: "device_offline",
      message: device.lastSeenAt
        ? `${device.nodeLabel} has not reported since ${device.lastSeenAt.toISOString()}`
        : `${device.nodeLabel} has never reported`,
      value: device.lastSeenAt,
      threshold: config.deviceOfflineAfterS,
      at: new Date(),
    });
  }

  return {
    devices: {
      total: devices.length,
      online,
      offline: devices.length - online,
      active: devices.filter((device) => device.isActive).length,
      byType,
    },
    readings24h: {
      count: totals.readings || 0,
      avgSoilMoisturePct: round1(totals.avgSoilMoisturePct),
      minSoilMoisturePct: round1(totals.minSoilMoisturePct),
      avgTemperatureC: round1(totals.avgTemperatureC),
      minTemperatureC: round1(totals.minTemperatureC),
      maxTemperatureC: round1(totals.maxTemperatureC),
      avgHumidityPct: round1(totals.avgHumidityPct),
      minBatteryMv: totals.minBatteryMv ?? null,
      rainReadings: totals.rainReadings || 0,
    },
    alerts,
  };
};

import mongoose from "mongoose";
import TelemetryReading from "./telemetry.model.js";
import Device from "./device.model.js";
import { isDeviceOnline, serializeDevice } from "./device.service.js";
import { emitToUser } from "../chat/socket.js";
import config from "../../config/env.js";
import { createLogger } from "../../shared/utils/logger.js";

const logger = createLogger("Telemetry");

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_READING_LIMIT = 200;

// An ESP32 with no NTP sync boots at the epoch and a drifting RTC can run
// ahead, so anything outside [now - 24h, now] is stamped with server time
// rather than dropped: the measurement itself is still real, only its clock is
// wrong, and a 1970 timestamp would sort a live reading off the end of every
// chart. 24h is the window because that is how long a gateway is expected to
// buffer while offline.
export const clampToServerTime = (raw, now = new Date()) => {
  if (!raw) return now;

  const parsed = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(parsed.getTime())) return now;
  if (parsed.getTime() > now.getTime()) return now;
  if (now.getTime() - parsed.getTime() > DAY_MS) return now;

  return parsed;
};

// Missing, blank and unparseable all collapse to null rather than 0 — see the
// comment on the measurement fields in telemetry.model.js. Multipart bodies
// arrive as strings, which is why this coerces rather than type-checks.
//
// The object/array guard is load-bearing, not defensive filler: Number([])
// is 0 and Number([45]) is 45 (both coerce via Array.prototype.toString()
// first), so an unvalidated batch entry like { soilMoisturePct: [] } would
// otherwise silently become a real 0% reading — able to trigger a critical
// soil_dry alert — instead of the null the contract requires for anything
// that isn't a genuine measurement.
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

// Derived from a single reading, so the five field-condition kinds only. The
// sixth, device_offline, is a statement about silence rather than about a
// reading and can never originate here — summary() raises it from lastSeenAt.
export const evaluateAlerts = (device, reading) => {
  const limits = device.thresholds || {};
  const alerts = [];
  const label = reading.nodeLabel || device.nodeLabel;

  if (reading.soilMoisturePct !== null && reading.soilMoisturePct !== undefined) {
    if (reading.soilMoisturePct <= limits.soilDryPct) {
      // Escalated below half the dry threshold: that is not "water it soon",
      // that is a crop already losing yield.
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
      // Always critical. Frost has no "keep an eye on it" version — the crop
      // is either covered before the night or it is lost.
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
    // 200 mV under the threshold is roughly where a LiPo falls off a cliff and
    // the node stops reporting altogether, which reads as a dead sensor rather
    // than a flat battery unless it is called out first.
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

export const ingestReadings = async (device, readings) => {
  const now = new Date();
  const incoming = Array.isArray(readings) ? readings : [];

  // The routes reject an oversized batch with a 400 before this runs; the slice
  // is here for the simulator and any other in-process caller, which bypass
  // that layer entirely.
  const batch = incoming.slice(0, config.telemetryMaxBatch);
  let rejected = incoming.length - batch.length;

  const documents = [];
  for (const raw of batch) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      rejected += 1;
      continue;
    }

    documents.push({
      device: device._id,
      owner: device.owner,
      nodeLabel:
        typeof raw.nodeLabel === "string" && raw.nodeLabel.trim()
          ? raw.nodeLabel.trim().toLowerCase().slice(0, 15)
          : device.nodeLabel,
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
    // ordered:false keeps going past a bad document, so a partial success still
    // throws — the ones that did land are on err.insertedDocs. Losing the whole
    // flush because one buffered reading was malformed is the thing to avoid.
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

  const newest = inserted.reduce((latest, reading) =>
    reading.recordedAt > latest.recordedAt ? reading : latest
  );

  // Only non-null measurements overwrite the cached values, so a cycle where
  // the battery divider failed to read does not blank out the last good
  // reading on the dashboard tile.
  const deviceUpdate = { lastSeenAt: now };
  if (newest.rssi !== null) deviceUpdate.lastRssi = newest.rssi;
  if (newest.batteryMv !== null) deviceUpdate.lastBatteryMv = newest.batteryMv;
  await Device.updateOne({ _id: device._id }, { $set: deviceUpdate });

  const ownerRoom = String(device.owner);
  const deviceSummary = {
    id: device._id,
    name: device.name,
    nodeLabel: device.nodeLabel,
    type: device.type,
  };

  // One event per accepted reading rather than one for the newest: the live
  // chart appends whatever it receives, so a gateway flushing an offline
  // buffer would otherwise leave a visible hole in the series.
  for (const reading of inserted) {
    emitToUser(ownerRoom, "telemetry_reading", {
      deviceId: device._id,
      device: deviceSummary,
      reading: serializeReading(reading),
    });
  }

  emitToUser(ownerRoom, "device_status", {
    deviceId: device._id,
    nodeLabel: device.nodeLabel,
    online: true,
    lastSeenAt: now,
    batteryMv: newest.batteryMv,
  });

  // Alerts come off the newest reading only. Replaying an eight-hour-old
  // dry-soil warning for every entry in a flushed buffer would bury the one
  // that describes the field as it is right now.
  for (const alert of evaluateAlerts(device, newest)) {
    emitToUser(ownerRoom, "telemetry_alert", alert);
  }

  return { accepted: inserted.length, rejected };
};

export const listReadings = async (ownerId, options = {}) => {
  const { deviceId, since, until } = options;

  const query = { owner: ownerId };
  // Scoped by owner as well as device id, so passing another account's device
  // id returns an empty series instead of their data.
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

// One indexed pass over {owner, recordedAt} instead of a findOne per device:
// the dashboard tiles stay a single round-trip no matter how many nodes end up
// in the field.
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
        // $avg/$min/$max skip nulls, which is the whole reason unfitted sensors
        // are stored as null — a fleet where two of five nodes have no DHT22
        // still reports the real average temperature of the three that do.
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
      // Only active devices raise device_offline. A node the user deliberately
      // deactivated for the season is silent on purpose and does not belong in
      // the alert list.
      offlineDevices.push(device);
    }
  }

  // Active alerts are whatever the most recent reading from each node still
  // says, not a stored alert log — a threshold the user edits takes effect on
  // the next summary rather than needing historical alerts re-evaluated.
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

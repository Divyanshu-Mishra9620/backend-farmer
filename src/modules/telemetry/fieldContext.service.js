import Device from "./device.model.js";
import TelemetryReading from "./telemetry.model.js";
import { coordsOf, distanceKm } from "../../shared/utils/geo.js";
import { createLogger } from "../../shared/utils/logger.js";

// What the farmer's own sensor measured on the field a camera photographed,
// around the moment of the photo. It travels with the diagnosis request to the
// RAG service, which derives a few rule-based "field signals" from it (wet
// spells and leaf disease, hot dry weather and mites, how to water given the
// soil) and lets the LLM explain them next to the grounded disease write-up.
//
// Everything here is measured or counted, never inferred: picking the sensor
// is deliberately conservative, because describing the wrong plot's soil is
// worse than saying nothing about it.

const logger = createLogger("FieldContext");

const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;

// Relative humidity counted as "humid" time. Keep in step with HUMID_PCT in the
// RAG service (app/services/field_context.py), which phrases the signal.
export const HUMID_PCT = 85;
// Readings older than this are flagged; the RAG service draws no conclusions from them.
export const STALE_AFTER_MIN = 180;
// A camera with no plot match may borrow a sensor this close to it.
export const NEAREST_SENSOR_KM = 0.5;
// A gap between two readings longer than this is not counted as humid time:
// a node that slept or went offline says nothing about the hours it missed.
const MAX_GAP_MS = 60 * MIN_MS;
const MAX_DAY_READINGS = 5000;
const RAIN_LOOKBACK_MS = 72 * HOUR_MS;

const READING_FIELDS = "soilMoisturePct temperatureC humidityPct rainDetected lux recordedAt";

const round1 = (n) => Math.round(n * 10) / 10;

// The RAG service validates every number against these ranges and drops the
// whole context if one is out of bounds, so anything a glitching sensor sends
// outside them is nulled here instead.
const inRange = (value, lo, hi) =>
  typeof value === "number" && Number.isFinite(value) && value >= lo && value <= hi
    ? round1(value)
    : null;
const pct = (v) => inRange(v, 0, 100);
const celsius = (v) => inRange(v, -40, 70);
const luxOf = (v) => inRange(v, 0, 200000);
const text = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

// "Plot A", "plot-a", "A" and "a" all name the same plot.
export const normalizePlot = (raw) =>
  typeof raw === "string"
    ? raw.toLowerCase().replace(/\bplot\b/g, "").replace(/[^a-z0-9]+/g, "")
    : "";

const lastSeen = (device) => new Date(device.lastSeenAt || 0).getTime();

// Which sensor describes the field this camera looks at, or null.
//   same_plot   a sensor registered to the camera's plot (most recently seen wins)
//   nearest     no plot match, but a sensor within NEAREST_SENSOR_KM by GPS
//   only_sensor the farm has exactly one sensor and nothing says it is elsewhere
// Several sensors with nothing tying one to the camera returns null on purpose.
export async function pickSensor(ownerId, camera, gateway) {
  const sensors = await Device.find({ owner: ownerId, type: "sensor", isActive: { $ne: false } });
  if (!sensors.length) return null;

  const plot = normalizePlot(camera?.plot) || normalizePlot(gateway?.plot);
  const conflicts = (sensor) => {
    const own = normalizePlot(sensor.plot);
    return Boolean(plot && own && own !== plot);
  };

  if (plot) {
    const samePlot = sensors.filter((s) => normalizePlot(s.plot) === plot);
    if (samePlot.length) {
      const [best] = [...samePlot].sort((a, b) => lastSeen(b) - lastSeen(a));
      return { device: best, matchedBy: "same_plot" };
    }
  }

  const here = coordsOf(camera?.location) || coordsOf(gateway?.location);
  if (here) {
    const near = sensors
      .filter((s) => !conflicts(s))
      .map((s) => ({ sensor: s, at: coordsOf(s.location) }))
      .filter((c) => c.at)
      .map((c) => ({ sensor: c.sensor, km: distanceKm(here, c.at) }))
      .filter((c) => c.km <= NEAREST_SENSOR_KM)
      .sort((a, b) => a.km - b.km);
    if (near.length) return { device: near[0].sensor, matchedBy: "nearest" };
  }

  if (sensors.length === 1 && !conflicts(sensors[0])) {
    return { device: sensors[0], matchedBy: "only_sensor" };
  }
  return null;
}

// Statistics over the readings of the 24 h before `atMs`, oldest first.
// humidHours is time-weighted: each reading at or above HUMID_PCT counts until
// the next reading (or the photo), capped at MAX_GAP_MS per gap.
export function summarizeDay(readings, atMs) {
  if (!readings.length) return null;

  const values = (pick) => readings.map(pick).filter((v) => v != null);
  const temps = values((r) => celsius(r.temperatureC));
  const hums = values((r) => pct(r.humidityPct));
  const soils = values((r) => pct(r.soilMoisturePct));
  const luxes = values((r) => luxOf(r.lux));
  const mean = (list) => (list.length ? round1(list.reduce((a, b) => a + b, 0) / list.length) : null);

  let humidMs = 0;
  readings.forEach((reading, i) => {
    const humidity = pct(reading.humidityPct);
    if (humidity == null || humidity < HUMID_PCT) return;
    const start = new Date(reading.recordedAt).getTime();
    const end = i + 1 < readings.length ? new Date(readings[i + 1].recordedAt).getTime() : atMs;
    humidMs += Math.min(Math.max(end - start, 0), MAX_GAP_MS);
  });

  const first = new Date(readings[0].recordedAt).getTime();
  return {
    readings: readings.length,
    hoursCovered: Math.min(24, round1((atMs - first) / HOUR_MS)),
    tempMinC: temps.length ? Math.min(...temps) : null,
    tempMaxC: temps.length ? Math.max(...temps) : null,
    tempAvgC: mean(temps),
    humidityAvgPct: mean(hums),
    humidityMaxPct: hums.length ? Math.max(...hums) : null,
    humidHours: hums.length ? Math.min(24, round1(humidMs / HOUR_MS)) : null,
    soilMinPct: soils.length ? Math.min(...soils) : null,
    soilMaxPct: soils.length ? Math.max(...soils) : null,
    luxMax: luxes.length ? Math.max(...luxes) : null,
    rainReadings: readings.filter((r) => r.rainDetected === true).length,
  };
}

// The field context for a photo taken by `camera` (forwarded by `gateway`) at
// `at`, or null when no sensor can honestly be tied to it or it has never
// reported. Never throws: a diagnosis must not fail because of this lookup.
export async function buildFieldContext({ ownerId, camera, gateway, at = new Date() }) {
  try {
    const picked = await pickSensor(ownerId, camera, gateway);
    if (!picked) return null;
    const { device, matchedBy } = picked;

    const atMs = new Date(at).getTime();
    const atDate = new Date(atMs);

    const recent = await TelemetryReading.find({
      device: device._id,
      recordedAt: { $gte: new Date(atMs - 24 * HOUR_MS), $lte: atDate },
    })
      .sort({ recordedAt: -1 })
      .limit(MAX_DAY_READINGS)
      .select(READING_FIELDS);

    let latest = recent[0];
    if (!latest) {
      [latest] = await TelemetryReading.find({ device: device._id, recordedAt: { $lte: atDate } })
        .sort({ recordedAt: -1 })
        .limit(1)
        .select(READING_FIELDS);
    }
    if (!latest) return null;

    const [lastRain] = await TelemetryReading.find({
      device: device._id,
      rainDetected: true,
      recordedAt: { $gte: new Date(atMs - RAIN_LOOKBACK_MS), $lte: atDate },
    })
      .sort({ recordedAt: -1 })
      .limit(1)
      .select("recordedAt");

    const ageMinutes = Math.max(0, round1((atMs - new Date(latest.recordedAt).getTime()) / MIN_MS));

    return {
      sensor: {
        deviceId: String(device._id),
        nodeLabel: text(device.nodeLabel, 32),
        name: text(device.name, 64),
        plot: text(device.plot, 64),
        matchedBy,
      },
      observedAt: new Date(latest.recordedAt).toISOString(),
      ageMinutes,
      stale: ageMinutes > STALE_AFTER_MIN,
      latest: {
        soilMoisturePct: pct(latest.soilMoisturePct),
        temperatureC: celsius(latest.temperatureC),
        humidityPct: pct(latest.humidityPct),
        rainDetected: typeof latest.rainDetected === "boolean" ? latest.rainDetected : null,
        lux: luxOf(latest.lux),
      },
      last24h: summarizeDay([...recent].reverse(), atMs),
      lastRainHoursAgo: lastRain
        ? Math.max(0, round1((atMs - new Date(lastRain.recordedAt).getTime()) / HOUR_MS))
        : null,
      thresholds: {
        soilDryPct: pct(device.thresholds?.soilDryPct) ?? 25,
        soilSaturatedPct: pct(device.thresholds?.soilSaturatedPct) ?? 85,
      },
    };
  } catch (err) {
    logger.warn("Could not build field context for a capture", { error: err.message });
    return null;
  }
}

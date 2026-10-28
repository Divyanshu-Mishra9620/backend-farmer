import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { createFakeModel } from "./setup/fakeModels.js";

// buildFieldContext() describes the field a camera photographed using the
// readings of ONE sensor it can honestly be tied to. These tests pin down how
// that sensor is chosen, how the 24 h numbers are counted, and that nothing
// here can break a diagnosis.

const Device = createFakeModel("Device");
const TelemetryReading = createFakeModel("TelemetryReading");

jest.unstable_mockModule("../src/modules/telemetry/device.model.js", () => ({ default: Device }));
jest.unstable_mockModule("../src/modules/telemetry/telemetry.model.js", () => ({ default: TelemetryReading }));

const { buildFieldContext, pickSensor, summarizeDay, normalizePlot, HUMID_PCT } = await import(
  "../src/modules/telemetry/fieldContext.service.js"
);

const owner = new mongoose.Types.ObjectId();
const AT = new Date("2026-10-12T12:00:00Z");
const minutesBefore = (m) => new Date(AT.getTime() - m * 60 * 1000);

const sensor = (over = {}) => ({
  owner,
  type: "sensor",
  isActive: true,
  nodeLabel: "plot-a-soil",
  name: "Plot A soil",
  plot: "A",
  lastSeenAt: minutesBefore(5),
  thresholds: { soilDryPct: 25, soilSaturatedPct: 85 },
  ...over,
});
const camera = (over = {}) => ({ _id: new mongoose.Types.ObjectId(), owner, type: "camera", nodeLabel: "plot-a-cam", plot: "Plot A", ...over });
const gateway = { _id: new mongoose.Types.ObjectId(), owner, type: "gateway", nodeLabel: "gw" };

const reading = (device, minutes, over = {}) => ({
  device: device._id,
  owner,
  recordedAt: minutesBefore(minutes),
  soilMoisturePct: 40,
  temperatureC: 26,
  humidityPct: 60,
  rainDetected: false,
  lux: null,
  ...over,
});

beforeEach(() => {
  Device.reset();
  TelemetryReading.reset();
});

describe("normalizePlot", () => {
  it("treats Plot A, plot-a, A and a as the same plot", () => {
    expect(new Set(["Plot A", "plot-a", "A", " a "].map(normalizePlot))).toEqual(new Set(["a"]));
    expect(normalizePlot("North Field")).toBe("northfield");
    expect(normalizePlot(null)).toBe("");
  });
});

describe("pickSensor", () => {
  it("prefers a sensor on the camera's plot, most recently seen first", async () => {
    Device.reset([
      sensor({ nodeLabel: "far", plot: "B" }),
      sensor({ nodeLabel: "old-a", lastSeenAt: minutesBefore(600) }),
      sensor({ nodeLabel: "new-a", lastSeenAt: minutesBefore(2) }),
    ]);
    const picked = await pickSensor(owner, camera(), gateway);
    expect(picked.matchedBy).toBe("same_plot");
    expect(picked.device.nodeLabel).toBe("new-a");
  });

  it("falls back to the nearest sensor within 500 m when no plot matches", async () => {
    Device.reset([
      sensor({ nodeLabel: "near", plot: null, location: { latitude: 26.7606, longitude: 83.3732 } }),
      sensor({ nodeLabel: "km-away", plot: null, location: { latitude: 26.78, longitude: 83.3732 } }),
    ]);
    const cam = camera({ plot: null, location: { latitude: 26.7609, longitude: 83.3735 } });
    const picked = await pickSensor(owner, cam, gateway);
    expect(picked).toMatchObject({ matchedBy: "nearest" });
    expect(picked.device.nodeLabel).toBe("near");
  });

  it("uses the farm's only sensor unless it is registered to another plot", async () => {
    Device.reset([sensor({ plot: null })]);
    expect((await pickSensor(owner, camera(), gateway)).matchedBy).toBe("only_sensor");

    Device.reset([sensor({ plot: "B" })]);
    expect(await pickSensor(owner, camera(), gateway)).toBeNull();
  });

  it("refuses to guess between several unrelated sensors", async () => {
    Device.reset([sensor({ nodeLabel: "x", plot: null }), sensor({ nodeLabel: "y", plot: null })]);
    expect(await pickSensor(owner, camera({ plot: null }), gateway)).toBeNull();
  });

  it("ignores inactive sensors and other farmers' sensors", async () => {
    Device.reset([
      sensor({ isActive: false }),
      sensor({ owner: new mongoose.Types.ObjectId(), nodeLabel: "theirs" }),
    ]);
    expect(await pickSensor(owner, camera(), gateway)).toBeNull();
  });
});

describe("summarizeDay", () => {
  const id = { _id: new mongoose.Types.ObjectId() };

  it("counts humid time between readings and caps long gaps at an hour", () => {
    const rows = [
      reading(id, 300, { humidityPct: 90 }), // humid until next reading 3 h later -> capped at 1 h
      reading(id, 120, { humidityPct: 88 }), // humid for 30 min
      reading(id, 90, { humidityPct: 70 }), // not humid
      reading(id, 60, { humidityPct: HUMID_PCT }), // exactly at the line counts: 30 min
      reading(id, 30, { humidityPct: 40 }),
    ];
    const day = summarizeDay(rows, AT.getTime());
    expect(day.humidHours).toBe(2);
    expect(day.readings).toBe(5);
    expect(day.humidityMaxPct).toBe(90);
  });

  it("reports ranges, averages and rain, and ignores impossible values", () => {
    const rows = [
      reading(id, 200, { temperatureC: 21, soilMoisturePct: 17, rainDetected: true }),
      reading(id, 100, { temperatureC: 31.54, soilMoisturePct: 24, humidityPct: 150 }),
      reading(id, 10, { temperatureC: 26, soilMoisturePct: 20, lux: 12400 }),
    ];
    const day = summarizeDay(rows, AT.getTime());
    expect(day).toMatchObject({
      tempMinC: 21,
      tempMaxC: 31.5,
      tempAvgC: 26.2,
      soilMinPct: 17,
      soilMaxPct: 24,
      humidityMaxPct: 60,
      luxMax: 12400,
      rainReadings: 1,
      hoursCovered: 3.3,
    });
  });

  it("is null without readings", () => {
    expect(summarizeDay([], AT.getTime())).toBeNull();
  });
});

describe("buildFieldContext", () => {
  it("describes the matched sensor's latest reading, the last 24 h and recent rain", async () => {
    Device.reset([sensor({ thresholds: { soilDryPct: 30, soilSaturatedPct: 90 } })]);
    const [plotSensor] = Device.rows;
    TelemetryReading.reset([
      reading(plotSensor, 60 * 30, { rainDetected: true }), // 30 h ago: inside 72 h, outside 24 h
      reading(plotSensor, 120, { humidityPct: 91 }),
      reading(plotSensor, 12, { soilMoisturePct: 18.44, temperatureC: 27.9, humidityPct: 67, lux: 9000 }),
      reading(plotSensor, -5, { soilMoisturePct: 99 }), // after the photo: never used
    ]);

    const ctx = await buildFieldContext({ ownerId: owner, camera: camera(), gateway, at: AT });

    expect(ctx.sensor).toMatchObject({ nodeLabel: "plot-a-soil", plot: "A", matchedBy: "same_plot" });
    expect(ctx.ageMinutes).toBe(12);
    expect(ctx.stale).toBe(false);
    expect(ctx.latest).toEqual({ soilMoisturePct: 18.4, temperatureC: 27.9, humidityPct: 67, rainDetected: false, lux: 9000 });
    expect(ctx.last24h.readings).toBe(2);
    expect(ctx.last24h.humidHours).toBe(1);
    expect(ctx.lastRainHoursAgo).toBe(30);
    expect(ctx.thresholds).toEqual({ soilDryPct: 30, soilSaturatedPct: 90 });
    expect(JSON.parse(JSON.stringify(ctx))).toEqual(ctx);
  });

  it("falls back to an older reading and flags it as stale", async () => {
    Device.reset([sensor()]);
    TelemetryReading.reset([reading(Device.rows[0], 60 * 30)]);
    const ctx = await buildFieldContext({ ownerId: owner, camera: camera(), gateway, at: AT });
    expect(ctx.ageMinutes).toBe(1800);
    expect(ctx.stale).toBe(true);
    expect(ctx.last24h).toBeNull();
  });

  it("is null when no sensor matches or the sensor never reported", async () => {
    expect(await buildFieldContext({ ownerId: owner, camera: camera(), gateway, at: AT })).toBeNull();
    Device.reset([sensor()]);
    expect(await buildFieldContext({ ownerId: owner, camera: camera(), gateway, at: AT })).toBeNull();
  });

  it("trims long names so the RAG service cannot reject the whole context", async () => {
    Device.reset([sensor({ name: "x".repeat(200), plot: "A" })]);
    TelemetryReading.reset([reading(Device.rows[0], 5)]);
    const ctx = await buildFieldContext({ ownerId: owner, camera: camera(), gateway, at: AT });
    expect(ctx.sensor.name).toHaveLength(64);
  });

  it("never throws: a database error means no field context", async () => {
    Device.reset([sensor()]);
    TelemetryReading.failNext("find", new Error("db down"));
    const spy = jest.spyOn(console, "warn").mockImplementation(() => {});
    await expect(buildFieldContext({ ownerId: owner, camera: camera(), gateway, at: AT })).resolves.toBeNull();
    spy.mockRestore();
  });
});

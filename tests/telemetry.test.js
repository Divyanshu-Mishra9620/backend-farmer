import request from "supertest";
import expressLoader from "../src/loaders/express.js";
import { connectTestDB, disconnectTestDB } from "./setup/testDb.js";
import { testUserPayload } from "./setup/factories.js";
import User from "../src/modules/user/user.model.js";
import Device from "../src/modules/telemetry/device.model.js";
import TelemetryReading from "../src/modules/telemetry/telemetry.model.js";
import DeviceCapture from "../src/modules/telemetry/capture.model.js";

let app;
let accessTokenA;
let accessTokenB;
const createdEmails = [];
const createdDeviceIds = [];
const FAKE_ID = "507f1f77bcf86cd799439011";

async function signupAndLogin(payload) {
  createdEmails.push(payload.email);
  await request(app).post("/api/auth/signup").send(payload);
  const res = await request(app)
    .post("/api/auth/login")
    .send({ email: payload.email, password: payload.password });
  return res.body.accessToken;
}

// nodeLabel has a hard 15-character ceiling (kn_protocol.h's char[16] on the
// radio side), so the generated label packs Date.now() as base36 rather than
// base10 — base10 plus a prefix and a random suffix overflows the limit.
function uniqueNodeLabel(prefix = "n") {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`.slice(0, 15);
}

async function registerDevice(token, overrides = {}) {
  const res = await request(app)
    .post("/api/telemetry/devices")
    .set("Authorization", `Bearer ${token}`)
    .send({
      name: "Test node",
      nodeLabel: uniqueNodeLabel(),
      type: "sensor",
      ...overrides,
    });
  if (res.body?.data?.device?.id) createdDeviceIds.push(res.body.data.device.id);
  return res;
}

beforeAll(async () => {
  await connectTestDB();
  app = await expressLoader();

  accessTokenA = await signupAndLogin(testUserPayload());
  accessTokenB = await signupAndLogin(testUserPayload());
});

afterAll(async () => {
  await TelemetryReading.deleteMany({ device: { $in: createdDeviceIds } });
  await DeviceCapture.deleteMany({ device: { $in: createdDeviceIds } });
  await Device.deleteMany({ _id: { $in: createdDeviceIds } });
  await User.deleteMany({ email: { $in: createdEmails } });
  await disconnectTestDB();
});

describe("device registration", () => {
  it("returns a plaintext key exactly once, and never again on a subsequent list", async () => {
    const res = await registerDevice(accessTokenA);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.deviceKey).toMatch(/^knd_[0-9a-f]{48}$/);
    expect(res.body.data.device.id).toBeTruthy();
    expect(res.body.data.device.keyHash).toBeUndefined();

    const list = await request(app)
      .get("/api/telemetry/devices")
      .set("Authorization", `Bearer ${accessTokenA}`);

    expect(list.status).toBe(200);
    const found = list.body.data.find((d) => d.id === res.body.data.device.id);
    expect(found).toBeTruthy();
    expect(found.deviceKey).toBeUndefined();
    expect(found.keyHash).toBeUndefined();
    // Only the prefix survives registration, for telling boards apart in the UI.
    expect(res.body.data.deviceKey.startsWith(found.keyPrefix)).toBe(true);
  });

  it("rejects a duplicate nodeLabel for the same owner with 409 CONFLICT", async () => {
    const nodeLabel = uniqueNodeLabel("dup");
    const first = await registerDevice(accessTokenA, { nodeLabel });
    expect(first.status).toBe(201);

    const second = await registerDevice(accessTokenA, { nodeLabel });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("CONFLICT");
  });

  it("allows the same nodeLabel across two different owners", async () => {
    const nodeLabel = uniqueNodeLabel("shr");
    const first = await registerDevice(accessTokenA, { nodeLabel });
    const second = await registerDevice(accessTokenB, { nodeLabel });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });

  it("rejects a nodeLabel longer than 15 characters", async () => {
    const res = await registerDevice(accessTokenA, {
      nodeLabel: "this-label-is-way-too-long",
    });
    expect(res.status).toBe(400);
    // express-validator failures are caught by routes.js's local `validate`,
    // which responds {success,message,errors} directly rather than routing
    // through httpError()/errorHandler's {success,error:{code}} shape — the
    // same two-shapes-for-400 split already present in detection.routes.js.
    expect(res.body.success).toBe(false);
    expect(Array.isArray(res.body.errors)).toBe(true);
  });
});

describe("device-facing auth (X-Device-Key)", () => {
  it("rejects ingest with no key header", async () => {
    const res = await request(app)
      .post("/api/telemetry/readings")
      .send({ temperatureC: 30 });

    expect(res.status).toBe(401);
  });

  it("rejects ingest with a malformed key", async () => {
    const res = await request(app)
      .post("/api/telemetry/readings")
      .set("X-Device-Key", "not-a-real-key")
      .send({ temperatureC: 30 });

    expect(res.status).toBe(401);
  });

  it("rejects ingest with a well-formed but unknown key", async () => {
    const res = await request(app)
      .post("/api/telemetry/readings")
      .set("X-Device-Key", `knd_${"a".repeat(48)}`)
      .send({ temperatureC: 30 });

    expect(res.status).toBe(401);
  });

  it("accepts ingest with a freshly issued key", async () => {
    const reg = await registerDevice(accessTokenA);
    const key = reg.body.data.deviceKey;

    const res = await request(app)
      .post("/api/telemetry/readings")
      .set("X-Device-Key", key)
      .send({ temperatureC: 31.5, soilMoisturePct: 40 });

    expect(res.status).toBe(201);
    expect(res.body.data.accepted).toBe(1);
    expect(res.body.data.rejected).toBe(0);
    expect(res.body.data.deviceId).toBe(reg.body.data.device.id);
    expect(res.body.data.config).toMatchObject({
      readingIntervalS: expect.any(Number),
      captureIntervalS: expect.any(Number),
      captureEnabled: expect.any(Boolean),
    });
  });

  it("invalidates the old key on rotation and accepts the new one", async () => {
    const reg = await registerDevice(accessTokenA);
    const deviceId = reg.body.data.device.id;
    const oldKey = reg.body.data.deviceKey;

    const rotate = await request(app)
      .post(`/api/telemetry/devices/${deviceId}/rotate-key`)
      .set("Authorization", `Bearer ${accessTokenA}`);

    expect(rotate.status).toBe(200);
    const newKey = rotate.body.data.deviceKey;
    expect(newKey).not.toBe(oldKey);

    const withOldKey = await request(app)
      .post("/api/telemetry/readings")
      .set("X-Device-Key", oldKey)
      .send({ temperatureC: 20 });
    expect(withOldKey.status).toBe(401);

    const withNewKey = await request(app)
      .post("/api/telemetry/readings")
      .set("X-Device-Key", newKey)
      .send({ temperatureC: 20 });
    expect(withNewKey.status).toBe(201);
  });

  it("403s a deactivated device instead of accepting its key", async () => {
    const reg = await registerDevice(accessTokenA);
    const deviceId = reg.body.data.device.id;
    const key = reg.body.data.deviceKey;

    const deactivate = await request(app)
      .patch(`/api/telemetry/devices/${deviceId}`)
      .set("Authorization", `Bearer ${accessTokenA}`)
      .send({ isActive: false });
    expect(deactivate.status).toBe(200);

    const res = await request(app)
      .post("/api/telemetry/readings")
      .set("X-Device-Key", key)
      .send({ temperatureC: 20 });

    expect(res.status).toBe(403);
  });
});

describe("reading ingest semantics", () => {
  it("stores an omitted measurement as null, never 0", async () => {
    const reg = await registerDevice(accessTokenA);
    const key = reg.body.data.deviceKey;
    const deviceId = reg.body.data.device.id;

    const ingest = await request(app)
      .post("/api/telemetry/readings")
      .set("X-Device-Key", key)
      // DHT22 failed to read this cycle: only temperature-adjacent fields are
      // sent. soilMoisturePct, humidityPct, batteryMv, rssi are all omitted.
      .send({ temperatureC: 33.4 });
    expect(ingest.status).toBe(201);

    const list = await request(app)
      .get(`/api/telemetry/readings?deviceId=${deviceId}`)
      .set("Authorization", `Bearer ${accessTokenA}`);

    expect(list.status).toBe(200);
    const reading = list.body.data[0];
    expect(reading.temperatureC).toBeCloseTo(33.4, 5);
    expect(reading.soilMoisturePct).toBeNull();
    expect(reading.humidityPct).toBeNull();
    expect(reading.batteryMv).toBeNull();
    expect(reading.rssi).toBeNull();
  });

  it("clamps a future-dated recordedAt to server time", async () => {
    const reg = await registerDevice(accessTokenA);
    const key = reg.body.data.deviceKey;
    const deviceId = reg.body.data.device.id;

    const future = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const before = Date.now();

    const ingest = await request(app)
      .post("/api/telemetry/readings")
      .set("X-Device-Key", key)
      .send({ temperatureC: 25, recordedAt: future });
    expect(ingest.status).toBe(201);

    const after = Date.now();

    const list = await request(app)
      .get(`/api/telemetry/readings?deviceId=${deviceId}`)
      .set("Authorization", `Bearer ${accessTokenA}`);

    const recordedAt = new Date(list.body.data[0].recordedAt).getTime();
    expect(recordedAt).toBeGreaterThanOrEqual(before);
    expect(recordedAt).toBeLessThanOrEqual(after);
  });

  it("clamps a stale (>24h old) recordedAt to server time", async () => {
    const reg = await registerDevice(accessTokenA);
    const key = reg.body.data.deviceKey;
    const deviceId = reg.body.data.device.id;

    const stale = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    const before = Date.now();

    const ingest = await request(app)
      .post("/api/telemetry/readings")
      .set("X-Device-Key", key)
      .send({ temperatureC: 18, recordedAt: stale });
    expect(ingest.status).toBe(201);

    const list = await request(app)
      .get(`/api/telemetry/readings?deviceId=${deviceId}`)
      .set("Authorization", `Bearer ${accessTokenA}`);

    const recordedAt = new Date(list.body.data[0].recordedAt).getTime();
    expect(recordedAt).toBeGreaterThanOrEqual(before);
  });

  it("accepts a batch flush and reports one event per reading", async () => {
    const reg = await registerDevice(accessTokenA);
    const key = reg.body.data.deviceKey;
    const deviceId = reg.body.data.device.id;

    const readings = Array.from({ length: 5 }, (_, i) => ({
      temperatureC: 20 + i,
      recordedAt: new Date(Date.now() - i * 60 * 1000).toISOString(),
    }));

    const ingest = await request(app)
      .post("/api/telemetry/readings")
      .set("X-Device-Key", key)
      .send({ readings });

    expect(ingest.status).toBe(201);
    expect(ingest.body.data.accepted).toBe(5);
    expect(ingest.body.data.rejected).toBe(0);

    const list = await request(app)
      .get(`/api/telemetry/readings?deviceId=${deviceId}&limit=10`)
      .set("Authorization", `Bearer ${accessTokenA}`);
    expect(list.body.data.length).toBe(5);
  });

  it("rejects a batch over the configured max with 400, not a partial accept", async () => {
    const reg = await registerDevice(accessTokenA);
    const key = reg.body.data.deviceKey;

    const readings = Array.from({ length: 51 }, () => ({ temperatureC: 20 }));

    const res = await request(app)
      .post("/api/telemetry/readings")
      .set("X-Device-Key", key)
      .send({ readings });

    expect(res.status).toBe(400);
    // Same express-validator response shape as the nodeLabel-length test above.
    expect(res.body.success).toBe(false);
    expect(Array.isArray(res.body.errors)).toBe(true);
  });
});

describe("ownership isolation", () => {
  it("404s (not 403) when reading another user's device by id", async () => {
    const owned = await registerDevice(accessTokenB);
    const deviceId = owned.body.data.device.id;

    const res = await request(app)
      .patch(`/api/telemetry/devices/${deviceId}`)
      .set("Authorization", `Bearer ${accessTokenA}`)
      .send({ name: "Hijacked" });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("404s when deleting another user's device", async () => {
    const owned = await registerDevice(accessTokenB);
    const deviceId = owned.body.data.device.id;

    const res = await request(app)
      .delete(`/api/telemetry/devices/${deviceId}`)
      .set("Authorization", `Bearer ${accessTokenA}`);

    expect(res.status).toBe(404);
  });

  it("404s for a well-formed but nonexistent device id", async () => {
    const res = await request(app)
      .delete(`/api/telemetry/devices/${FAKE_ID}`)
      .set("Authorization", `Bearer ${accessTokenA}`);

    expect(res.status).toBe(404);
  });

  it("never returns another owner's readings from listReadings, even by deviceId", async () => {
    const owned = await registerDevice(accessTokenB);
    const key = owned.body.data.deviceKey;
    const deviceId = owned.body.data.device.id;

    await request(app)
      .post("/api/telemetry/readings")
      .set("X-Device-Key", key)
      .send({ temperatureC: 22 });

    const res = await request(app)
      .get(`/api/telemetry/readings?deviceId=${deviceId}`)
      .set("Authorization", `Bearer ${accessTokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe("GET /readings/latest", () => {
  it("returns exactly one row per device, including devices with no reading yet", async () => {
    const withReading = await registerDevice(accessTokenA);
    const withoutReading = await registerDevice(accessTokenA);

    await request(app)
      .post("/api/telemetry/readings")
      .set("X-Device-Key", withReading.body.data.deviceKey)
      .send({ temperatureC: 27 });

    const res = await request(app)
      .get("/api/telemetry/readings/latest")
      .set("Authorization", `Bearer ${accessTokenA}`);

    expect(res.status).toBe(200);

    const ids = res.body.data.map((row) => row.device.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(withReading.body.data.device.id);
    expect(ids).toContain(withoutReading.body.data.device.id);

    const emptyRow = res.body.data.find(
      (row) => row.device.id === withoutReading.body.data.device.id
    );
    expect(emptyRow.reading).toBeNull();

    const filledRow = res.body.data.find(
      (row) => row.device.id === withReading.body.data.device.id
    );
    expect(filledRow.reading.temperatureC).toBeCloseTo(27, 5);
  });
});

describe("captures endpoint (analyze=false path only — no live AI calls)", () => {
  it("stores a capture without running the AI pipeline when analyze=false", async () => {
    const reg = await registerDevice(accessTokenA, { type: "camera" });
    const key = reg.body.data.deviceKey;

    const res = await request(app)
      .post("/api/telemetry/captures")
      .set("X-Device-Key", key)
      .field("analyze", "false")
      .field("trigger", "manual")
      .attach("image", Buffer.from(FAKE_JPEG_BYTES), "leaf.jpg");

    expect(res.status).toBe(202);
    expect(res.body.data.captureId).toBeTruthy();
    expect(res.body.data.status).toBe("completed");
    expect(res.body.data.analysisId).toBeFalsy();
  });

  it("rejects a capture with no image file", async () => {
    const reg = await registerDevice(accessTokenA, { type: "camera" });
    const key = reg.body.data.deviceKey;

    const res = await request(app)
      .post("/api/telemetry/captures")
      .set("X-Device-Key", key)
      .field("analyze", "false");

    expect(res.status).toBe(400);
  });
});

// A minimal-but-valid JPEG (the smallest real decodeable file: 1x1 white
// pixel) — validateImageContent sniffs actual magic bytes, so a text stub
// would 400 before ever reaching the controller under test.
const FAKE_JPEG_BYTES = [
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
  0x00, 0x03, 0x02, 0x02, 0x02, 0x02, 0x02, 0x03, 0x02, 0x02, 0x02, 0x03,
  0x03, 0x03, 0x03, 0x04, 0x06, 0x04, 0x04, 0x04, 0x04, 0x04, 0x08, 0x06,
  0x06, 0x05, 0x06, 0x09, 0x08, 0x0a, 0x0a, 0x09, 0x08, 0x09, 0x09, 0x0a,
  0x0c, 0x0f, 0x0c, 0x0a, 0x0b, 0x0e, 0x0b, 0x09, 0x09, 0x0d, 0x11, 0x0d,
  0x0e, 0x0f, 0x10, 0x10, 0x11, 0x10, 0x0a, 0x0c, 0x12, 0x13, 0x12, 0x10,
  0x13, 0x0f, 0x10, 0x10, 0x10, 0xff, 0xc9, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xcc, 0x00, 0x06, 0x00, 0x10,
  0x10, 0x05, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
  0xd2, 0xcf, 0x20, 0xff, 0xd9,
];

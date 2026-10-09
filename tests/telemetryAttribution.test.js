// Mock-based tests for the gateway -> leaf-device attribution, the ack runtime
// handling, the validation error shape and the device rate limiting.
//
// No MongoDB needed: every model is replaced with an in-memory stub, so these
// run anywhere. They sit beside telemetry.test.js (which exercises the same
// routes against a real database) rather than replacing it.
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import express from "express";
import request from "supertest";

process.env.JWT_SECRET ||= "test-jwt-secret";
process.env.JWT_REFRESH_SECRET ||= "test-jwt-refresh-secret";
process.env.ALLOWED_ORIGINS ||= "http://localhost:3000";

// ---------------------------------------------------------------------------
// Module mocks (must be registered before the modules under test are imported)
// ---------------------------------------------------------------------------

const deviceModel = {
  find: jest.fn(),
  findOne: jest.fn(),
  updateOne: jest.fn(() => Promise.resolve({})),
  findOneAndUpdate: jest.fn(() => Promise.resolve(null)),
};
const readingModel = { insertMany: jest.fn() };
const captureModel = { create: jest.fn() };
const commandModel = { findOne: jest.fn() };
const emitToUser = jest.fn();
const analyzeImage = jest.fn(() => new Promise(() => {}));

jest.unstable_mockModule("../src/modules/telemetry/device.model.js", () => ({
  default: deviceModel,
}));
jest.unstable_mockModule("../src/modules/telemetry/telemetry.model.js", () => ({
  default: readingModel,
}));
jest.unstable_mockModule("../src/modules/telemetry/capture.model.js", () => ({
  default: captureModel,
}));
jest.unstable_mockModule("../src/modules/telemetry/command.model.js", () => ({
  default: commandModel,
}));
jest.unstable_mockModule("../src/modules/user/user.model.js", () => ({
  default: { findById: jest.fn(() => ({ select: async () => null })) },
}));
jest.unstable_mockModule("../src/modules/chat/socket.js", () => ({ emitToUser }));
jest.unstable_mockModule("../src/shared/utils/pushSender.js", () => ({
  sendPushToUser: jest.fn(),
}));
jest.unstable_mockModule(
  "../src/modules/disease-detection/detection.service.js",
  () => ({ analyzeImage })
);
jest.unstable_mockModule("../src/shared/utils/cloudinary.js", () => ({
  uploadToCloudinary: jest.fn(),
}));

// Router-level tests: the real routes, validators, deviceAuth and limiters, with
// the controller and the upload plumbing stubbed out.
const echo = (req, res) => res.status(200).json({ success: true, body: req.body });
jest.unstable_mockModule("../src/modules/telemetry/telemetry.controller.js", () => ({
  ingestReadings: echo,
  createCapture: echo,
  getDeviceConfig: echo,
  acknowledgeCommand: echo,
  registerDevice: echo,
  listDevices: echo,
  updateDevice: echo,
  rotateDeviceKey: echo,
  deleteDevice: echo,
  listLatestReadings: echo,
  listReadings: echo,
  listCaptures: echo,
  getSummary: echo,
  sprayNow: echo,
  stopSpray: echo,
  getActuatorStatus: echo,
  listCommands: echo,
  cancelCommand: echo,
}));
const passThrough = (req, res, next) => next();
jest.unstable_mockModule("../src/shared/utils/upload.js", () => ({
  uploadSingle: passThrough,
}));
jest.unstable_mockModule("../src/shared/middlewares/validateImageContent.js", () => ({
  validateImageContent: passThrough,
}));
jest.unstable_mockModule("../src/shared/middlewares/authMiddleware.js", () => ({
  authMiddleware: (req, res, next) => next(),
}));

const { ingestReadings } = await import("../src/modules/telemetry/telemetry.service.js");
const { createCapture } = await import("../src/modules/telemetry/capture.service.js");
const { acknowledgeCommand } = await import("../src/modules/telemetry/command.service.js");
const { normalizeNodeLabel, resolveNodeDevices } = await import(
  "../src/modules/telemetry/device.service.js"
);
const { generateDeviceKey } = await import("../src/modules/telemetry/deviceKey.js");
const { generalLimiter, isDeviceRequest } = await import(
  "../src/shared/middlewares/rateLimiter.js"
);
const { default: telemetryRoutes } = await import(
  "../src/modules/telemetry/telemetry.routes.js"
);
const { default: errorHandler } = await import(
  "../src/shared/middlewares/errorHandler.js"
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER = "507f1f77bcf86cd799439011";

const makeDevice = (overrides = {}) => ({
  _id: `dev-${overrides.nodeLabel || "x"}`,
  owner: OWNER,
  name: overrides.nodeLabel || "x",
  nodeLabel: "gateway-1",
  type: "gateway",
  isActive: true,
  thresholds: { soilDryPct: 30, soilSaturatedPct: 90, heatStressC: 40, frostRiskC: 2, batteryLowMv: 3400 },
  ...overrides,
});

const gateway = () => makeDevice({ _id: "gw", nodeLabel: "gateway-1", type: "gateway" });
const soilLeaf = (o = {}) =>
  makeDevice({ _id: "leaf-soil", nodeLabel: "plot-a-soil", type: "sensor", ...o });

const reading = (over = {}) => ({
  nodeLabel: "plot-a-soil",
  soilMoisturePct: 55,
  temperatureC: 28,
  humidityPct: 60,
  batteryMv: 3900,
  rssi: -60,
  ...over,
});

const emitted = (event) =>
  emitToUser.mock.calls.filter((c) => c[1] === event).map((c) => c[2]);

beforeEach(() => {
  jest.clearAllMocks();
  readingModel.insertMany.mockImplementation(async (docs) =>
    docs.map((d, i) => ({ _id: `r${i}`, ...d }))
  );
  deviceModel.find.mockResolvedValue([]);
  captureModel.create.mockImplementation(async (doc) => ({
    _id: "cap1",
    ...doc,
    save: jest.fn(async () => {}),
  }));
});

// ---------------------------------------------------------------------------
// Label normalisation and lookup
// ---------------------------------------------------------------------------

describe("normalizeNodeLabel", () => {
  it("lower-cases, trims and caps at 15 characters; non-strings become null", () => {
    expect(normalizeNodeLabel("  PLOT-A-Soil ")).toBe("plot-a-soil");
    expect(normalizeNodeLabel("x".repeat(40))).toBe("x".repeat(15));
    expect(normalizeNodeLabel("")).toBeNull();
    expect(normalizeNodeLabel("   ")).toBeNull();
    expect(normalizeNodeLabel(undefined)).toBeNull();
    expect(normalizeNodeLabel(42)).toBeNull();
  });
});

describe("resolveNodeDevices", () => {
  it("only ever looks within the gateway's own owner and never matches another gateway", async () => {
    deviceModel.find.mockResolvedValue([soilLeaf()]);
    const map = await resolveNodeDevices(gateway(), ["plot-a-soil"]);

    expect(deviceModel.find).toHaveBeenCalledWith({
      owner: OWNER,
      nodeLabel: { $in: ["plot-a-soil"] },
      type: { $ne: "gateway" },
    });
    expect(map.get("plot-a-soil")._id).toBe("leaf-soil");
  });

  it("is a no-op for a non-gateway key, for the gateway's own label and for empty input", async () => {
    expect((await resolveNodeDevices(soilLeaf(), ["other"])).size).toBe(0);
    expect((await resolveNodeDevices(gateway(), ["gateway-1", null, ""])).size).toBe(0);
    expect((await resolveNodeDevices(gateway(), [])).size).toBe(0);
    expect(deviceModel.find).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Readings
// ---------------------------------------------------------------------------

describe("ingestReadings attribution", () => {
  it("files a gateway's forwarded reading under the leaf device it names", async () => {
    const gw = gateway();
    const leaf = soilLeaf();
    deviceModel.find.mockResolvedValue([leaf]);

    const result = await ingestReadings(gw, [reading()]);

    expect(result).toEqual({ accepted: 1, rejected: 0 });
    const [docs] = readingModel.insertMany.mock.calls[0];
    expect(docs[0].device).toBe("leaf-soil");
    expect(docs[0].nodeLabel).toBe("plot-a-soil");
    expect(docs[0].owner).toBe(OWNER);

    expect(deviceModel.updateOne).toHaveBeenCalledWith(
      { _id: "leaf-soil" },
      { $set: expect.objectContaining({ lastBatteryMv: 3900, lastRssi: -60 }) }
    );

    const live = emitted("telemetry_reading");
    expect(live).toHaveLength(1);
    expect(live[0].deviceId).toBe("leaf-soil");

    const statuses = emitted("device_status").map((s) => s.deviceId);
    expect(statuses).toContain("leaf-soil");
    expect(statuses).toContain("gw"); // the gateway card stays live too
  });

  it("splits a mixed batch across the leaves and the gateway", async () => {
    deviceModel.find.mockResolvedValue([soilLeaf()]);

    const result = await ingestReadings(gateway(), [
      reading(),
      reading({ nodeLabel: "gateway-1", soilMoisturePct: null }),
      reading({ nodeLabel: "unregistered" }),
      reading({ nodeLabel: undefined }),
    ]);

    expect(result.accepted).toBe(4);
    const targets = readingModel.insertMany.mock.calls[0][0].map((d) => d.device);
    expect(targets).toEqual(["leaf-soil", "gw", "gw", "gw"]);
  });

  it("keeps the unknown label on the gateway rather than dropping the data", async () => {
    const result = await ingestReadings(gateway(), [reading({ nodeLabel: "nobody" })]);

    expect(result.accepted).toBe(1);
    const [doc] = readingModel.insertMany.mock.calls[0][0];
    expect(doc.device).toBe("gw");
    expect(doc.nodeLabel).toBe("nobody");
  });

  it("matches labels case-insensitively", async () => {
    deviceModel.find.mockResolvedValue([soilLeaf()]);
    await ingestReadings(gateway(), [reading({ nodeLabel: "PLOT-A-SOIL" })]);
    expect(readingModel.insertMany.mock.calls[0][0][0].device).toBe("leaf-soil");
  });

  it("does not let a plain sensor key write for another device", async () => {
    const sensor = soilLeaf({ _id: "mine", nodeLabel: "mine" });
    await ingestReadings(sensor, [reading({ nodeLabel: "someone-else" })]);

    expect(deviceModel.find).not.toHaveBeenCalled();
    expect(readingModel.insertMany.mock.calls[0][0][0].device).toBe("mine");
  });

  it("rejects readings for a deactivated leaf but still stores the rest", async () => {
    deviceModel.find.mockResolvedValue([soilLeaf({ isActive: false })]);

    const result = await ingestReadings(gateway(), [
      reading(),
      reading({ nodeLabel: "gateway-1" }),
    ]);

    expect(result).toEqual({ accepted: 1, rejected: 1 });
    expect(readingModel.insertMany.mock.calls[0][0]).toHaveLength(1);
    expect(readingModel.insertMany.mock.calls[0][0][0].device).toBe("gw");
  });

  it("raises alerts against the leaf's own thresholds", async () => {
    deviceModel.find.mockResolvedValue([
      soilLeaf({ thresholds: { soilDryPct: 30, soilSaturatedPct: 90, heatStressC: 40, frostRiskC: 2, batteryLowMv: 3400 } }),
    ]);

    await ingestReadings(gateway(), [reading({ soilMoisturePct: 10 })]);

    const alerts = emitted("telemetry_alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ deviceId: "leaf-soil", kind: "soil_dry" });
  });

  it("counts non-object entries as rejected and returns early when nothing is usable", async () => {
    const result = await ingestReadings(gateway(), [null, "x", [1]]);
    expect(result).toEqual({ accepted: 0, rejected: 3 });
    expect(readingModel.insertMany).not.toHaveBeenCalled();
  });

  it("an ordinary self-labelled reading still lands on the authenticated device", async () => {
    const sensor = soilLeaf({ _id: "mine", nodeLabel: "plot-a-soil" });
    const result = await ingestReadings(sensor, [reading()]);

    expect(result.accepted).toBe(1);
    expect(readingModel.insertMany.mock.calls[0][0][0].device).toBe("mine");
  });
});

// ---------------------------------------------------------------------------
// Captures
// ---------------------------------------------------------------------------

describe("createCapture attribution", () => {
  const tmpFile = () => {
    const file = path.join(os.tmpdir(), `kn-capture-${Date.now()}-${Math.random()}.jpg`);
    fs.writeFileSync(file, "x");
    return { path: file, originalname: "frame.jpg" };
  };

  it("files a gateway-uploaded frame under the camera device it names", async () => {
    const camera = makeDevice({ _id: "leaf-cam", nodeLabel: "plot-a-cam", type: "camera", crop: "tomato" });
    deviceModel.find.mockResolvedValue([camera]);
    const file = tmpFile();

    const out = await createCapture(gateway(), file, {
      nodeLabel: "plot-a-cam",
      analyze: true,
      batteryMv: "3800",
    });

    expect(captureModel.create.mock.calls[0][0].device).toBe("leaf-cam");
    expect(out.deviceId).toBe("leaf-cam");
    expect(emitted("device_capture_received")[0].deviceId).toBe("leaf-cam");
    expect(analyzeImage.mock.calls[0][0].crop).toBe("tomato");
    expect(deviceModel.updateOne).toHaveBeenCalledWith(
      { _id: "leaf-cam" },
      { $set: expect.objectContaining({ lastBatteryMv: 3800 }) }
    );
    fs.rmSync(file.path, { force: true });
  });

  it("falls back to the gateway when the label is unknown", async () => {
    const file = tmpFile();
    const out = await createCapture(gateway(), file, { nodeLabel: "ghost", analyze: true });

    expect(out.deviceId).toBe("gw");
    expect(deviceModel.updateOne).not.toHaveBeenCalled();
    fs.rmSync(file.path, { force: true });
  });

  it("refuses a frame for a deactivated camera and removes the upload", async () => {
    deviceModel.find.mockResolvedValue([
      makeDevice({ _id: "leaf-cam", nodeLabel: "plot-a-cam", type: "camera", isActive: false }),
    ]);
    const file = tmpFile();

    await expect(
      createCapture(gateway(), file, { nodeLabel: "plot-a-cam", analyze: true })
    ).rejects.toMatchObject({ status: 403 });

    expect(captureModel.create).not.toHaveBeenCalled();
    expect(fs.existsSync(file.path)).toBe(false);
  });

  it("the analyze=false path still completes and cleans up the local file", async () => {
    const file = tmpFile();
    const out = await createCapture(gateway(), file, { analyze: false });

    expect(out.status).toBe("completed");
    expect(out.deviceId).toBe("gw");
    expect(fs.existsSync(file.path)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Command acknowledgement
// ---------------------------------------------------------------------------

describe("acknowledgeCommand runtime handling", () => {
  const liveCommand = () => ({
    _id: "cmd1",
    owner: OWNER,
    device: "gw",
    actuator: "sprinkler",
    action: "on",
    durationS: 60,
    status: "sent",
    expiresAt: new Date(Date.now() + 60000),
    save: jest.fn(async () => {}),
  });

  const ack = async (payload) => {
    const cmd = liveCommand();
    commandModel.findOne.mockResolvedValue(cmd);
    await acknowledgeCommand(gateway(), "cmd1", payload);
    return cmd;
  };

  it.each([
    [null, undefined],
    [undefined, undefined],
    ["", undefined],
    ["abc", undefined],
    [-5, undefined],
    [0, 0],
    [12, 12],
    ["30", 30],
  ])("actualRuntimeS %p is stored as %p", async (input, expected) => {
    const cmd = await ack({ executed: true, actualRuntimeS: input });
    expect(cmd.result.actualRuntimeS).toBe(expected);
  });

  it("records executed:false as failed, and a missing flag as executed", async () => {
    expect((await ack({ executed: false })).status).toBe("failed");
    expect((await ack({})).status).toBe("acked");
  });

  it("truncates a long error string to 300 characters", async () => {
    const cmd = await ack({ executed: false, error: "e".repeat(1000) });
    expect(cmd.result.error).toHaveLength(300);
  });
});

// ---------------------------------------------------------------------------
// Router: validation shape, null-tolerant ack, rate limiting
// ---------------------------------------------------------------------------

describe("device routes", () => {
  const credentials = generateDeviceKey();
  const burstCredentials = generateDeviceKey();
  const known = new Map([
    [
      credentials.keyHash,
      { _id: "gw", id: "gw", owner: OWNER, isActive: true, keyHash: credentials.keyHash },
    ],
    [
      burstCredentials.keyHash,
      { _id: "gw2", id: "gw2", owner: OWNER, isActive: true, keyHash: burstCredentials.keyHash },
    ],
  ]);

  let app;
  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use("/api", generalLimiter);
    app.get("/api/other", (req, res) => res.json({ ok: true }));
    app.use("/api/telemetry", telemetryRoutes);
    app.use(errorHandler);
  });

  beforeEach(() => {
    deviceModel.findOne.mockImplementation(({ keyHash }) => ({
      select: async () => known.get(keyHash) || null,
    }));
  });

  const post = (url, key = credentials.key) =>
    request(app).post(url).set("X-Device-Key", key);

  const ACK_URL = "/api/telemetry/commands/507f1f77bcf86cd799439012/ack";

  it("answers a validation failure in the contract shape and keeps the legacy fields", async () => {
    const res = await post("/api/telemetry/readings").send({ soilMoisturePct: 500 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.message).toContain("soilMoisturePct");
    expect(res.body.message).toBe("Validation failed");
    expect(Array.isArray(res.body.errors)).toBe(true);
  });

  it("accepts an ack carrying JSON nulls for what the device did not measure", async () => {
    const res = await post(ACK_URL).send({ executed: false, actualRuntimeS: null, error: null });
    expect(res.status).toBe(200);
  });

  it("accepts an ack whose error string is longer than the stored 300 characters", async () => {
    const res = await post(ACK_URL).send({ executed: false, error: "e".repeat(1000) });
    expect(res.status).toBe(200);
  });

  it("still rejects a non-numeric runtime and a bad command id", async () => {
    const badRuntime = await post(ACK_URL).send({ actualRuntimeS: "abc" });
    expect(badRuntime.status).toBe(400);
    expect(badRuntime.body.error.code).toBe("VALIDATION_ERROR");

    const badId = await post("/api/telemetry/commands/not-an-id/ack").send({});
    expect(badId.status).toBe(400);
  });

  describe("isDeviceRequest", () => {
    const req = (method, p, key = "knd_x") => ({
      method,
      path: p,
      headers: key === null ? {} : { "x-device-key": key },
    });

    it("matches the four device routes only, and only with a key header", () => {
      expect(isDeviceRequest(req("POST", "/telemetry/readings"))).toBe(true);
      expect(isDeviceRequest(req("POST", "/telemetry/captures"))).toBe(true);
      expect(isDeviceRequest(req("GET", "/telemetry/config"))).toBe(true);
      expect(isDeviceRequest(req("POST", "/telemetry/commands/abc123/ack"))).toBe(true);

      expect(isDeviceRequest(req("POST", "/telemetry/readings", null))).toBe(false);
      expect(isDeviceRequest(req("GET", "/telemetry/readings"))).toBe(false);
      expect(isDeviceRequest(req("POST", "/telemetry/devices"))).toBe(false);
      expect(isDeviceRequest(req("POST", "/telemetry/devices/abc/spray"))).toBe(false);
      expect(isDeviceRequest(req("POST", "/auth/login"))).toBe(false);
    });
  });

  it("does not apply the shared 100-per-window IP limit to a device's own traffic", async () => {
    // 110 > 100 (the general cap) but < 120 (the per-device cap).
    for (let i = 0; i < 110; i += 1) {
      const res = await request(app)
        .get("/api/telemetry/config")
        .set("X-Device-Key", burstCredentials.key);
      if (res.status !== 200) throw new Error(`request ${i} got ${res.status}`);
    }
  });

  it("still applies the shared limit to everything else", async () => {
    let last;
    for (let i = 0; i < 101; i += 1) {
      last = await request(app).get("/api/other");
    }
    expect(last.status).toBe(429);
  });

  // Keep this last: it exhausts the failed-auth bucket for the test client's IP.
  it("cuts off an address that keeps presenting unknown device keys", async () => {
    const unknown = generateDeviceKey().key;
    let sawLimit = false;
    for (let i = 0; i < 120 && !sawLimit; i += 1) {
      const res = await post("/api/telemetry/readings", unknown).send({});
      if (res.status === 429) sawLimit = true;
      else expect(res.status).toBe(401);
    }
    expect(sawLimit).toBe(true);
  });
});

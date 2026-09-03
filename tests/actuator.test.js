import request from "supertest";
import expressLoader from "../src/loaders/express.js";
import { connectTestDB, disconnectTestDB } from "./setup/testDb.js";
import { testUserPayload } from "./setup/factories.js";
import User from "../src/modules/user/user.model.js";
import Device from "../src/modules/telemetry/device.model.js";
import ActuatorCommand from "../src/modules/telemetry/command.model.js";
import TelemetryReading from "../src/modules/telemetry/telemetry.model.js";
import { generateDeviceKey } from "../src/modules/telemetry/deviceKey.js";
import config from "../src/config/env.js";

let app;
let tokenA;
let tokenB;
let userAId;
const createdEmails = [];
const createdDeviceIds = [];

async function signupAndLogin(payload) {
  createdEmails.push(payload.email);
  await request(app).post("/api/auth/signup").send(payload);
  const res = await request(app)
    .post("/api/auth/login")
    .send({ email: payload.email, password: payload.password });
  return res.body.accessToken;
}

function uniqueNodeLabel(prefix = "a") {
  return `${prefix}${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 4)}`.slice(0, 15);
}

/**
 * Create a commissioned gateway directly through the model rather than over
 * HTTP.
 *
 * Registering + commissioning each device through the API costs two requests,
 * and this suite needs a fresh device per test to keep cooldown and daily-budget
 * state from leaking between cases. At ~25 tests that is 50 requests spent on
 * setup alone, which blows the IP-keyed generalLimiter (100 per 15 min) and
 * turns unrelated assertions into 429s. Device registration has its own
 * coverage in telemetry.test.js; what is under test here is the command queue,
 * so the setup path is taken out of the HTTP budget entirely.
 */
async function makeGateway({ sprinklerEnabled = true, owner, ...overrides } = {}) {
  const { key, keyHash, keyPrefix } = generateDeviceKey();
  const device = await Device.create({
    owner: owner || userAId,
    name: "Gateway with relay",
    nodeLabel: uniqueNodeLabel(),
    type: "gateway",
    keyHash,
    keyPrefix,
    actuators: { sprinklerEnabled },
    ...overrides,
  });

  createdDeviceIds.push(device._id);
  return { id: String(device._id), deviceKey: key };
}

const spray = (token, deviceId, body = {}) =>
  request(app)
    .post(`/api/telemetry/devices/${deviceId}/spray`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);

const ingest = (deviceKey, body = {}) =>
  request(app)
    .post("/api/telemetry/readings")
    .set("X-Device-Key", deviceKey)
    .send({ soilMoisturePct: 30, ...body });

beforeAll(async () => {
  await connectTestDB();
  app = await expressLoader();

  const payloadA = testUserPayload();
  tokenA = await signupAndLogin(payloadA);
  tokenB = await signupAndLogin(testUserPayload());

  userAId = (await User.findOne({ email: payloadA.email }).select("_id"))._id;
});

afterAll(async () => {
  await ActuatorCommand.deleteMany({ device: { $in: createdDeviceIds } });
  await TelemetryReading.deleteMany({ device: { $in: createdDeviceIds } });
  await Device.deleteMany({ _id: { $in: createdDeviceIds } });
  await User.deleteMany({ email: { $in: createdEmails } });
  await disconnectTestDB();
});

describe("commissioning", () => {
  it("refuses to spray a device whose relay has not been enabled", async () => {
    const { id } = await makeGateway({ sprinklerEnabled: false });
    const res = await spray(tokenA, id);
    expect(res.status).toBe(409);
  });

  it("a device registered through the API has no sprinkler until it is commissioned", async () => {
    // Goes through the real registration path on purpose: the default that
    // matters is the schema's, and asserting it against a hand-built document
    // would only be testing the test factory.
    const reg = await request(app)
      .post("/api/telemetry/devices")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ name: "Fresh gateway", nodeLabel: uniqueNodeLabel("f"), type: "gateway" });

    expect(reg.status).toBe(201);
    createdDeviceIds.push(reg.body.data.device.id);
    expect(reg.body.data.device.actuators.sprinklerEnabled).toBe(false);

    const res = await spray(tokenA, reg.body.data.device.id, { durationS: 10 });
    expect(res.status).toBe(409);
  });

  it("accepts a spray once the relay is commissioned", async () => {
    const { id } = await makeGateway();
    const res = await spray(tokenA, id, { durationS: 30 });
    expect(res.status).toBe(202);
    expect(res.body.data.command.action).toBe("on");
    expect(res.body.data.grantedDurationS).toBe(30);
  });
});

describe("ownership isolation", () => {
  it("another user cannot spray a device they do not own", async () => {
    const { id } = await makeGateway();
    const res = await spray(tokenB, id, { durationS: 10 });
    // 404 rather than 403 — a 403 would confirm the device id is real.
    expect(res.status).toBe(404);
  });

  it("another user cannot read a device's actuator status", async () => {
    const { id } = await makeGateway();
    const res = await request(app)
      .get(`/api/telemetry/devices/${id}/actuator`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });
});

describe("runtime limits", () => {
  it("clamps a request above the device cap instead of rejecting it", async () => {
    const { id } = await makeGateway();
    await Device.updateOne({ _id: id }, { $set: { "actuators.maxRuntimeS": 20 } });

    const res = await spray(tokenA, id, { durationS: 600 });
    expect(res.status).toBe(202);
    expect(res.body.data.grantedDurationS).toBe(20);
    expect(res.body.data.requestedDurationS).toBe(600);
    expect(res.body.data.clamped).toBe(true);
  });

  it("defaults to the device cap when no duration is given", async () => {
    const { id } = await makeGateway();
    await Device.updateOne({ _id: id }, { $set: { "actuators.maxRuntimeS": 45 } });

    const res = await spray(tokenA, id);
    expect(res.status).toBe(202);
    expect(res.body.data.grantedDurationS).toBe(45);
  });

  it("refuses a second spray while one is still in flight", async () => {
    const { id } = await makeGateway();
    expect((await spray(tokenA, id, { durationS: 10 })).status).toBe(202);

    const second = await spray(tokenA, id, { durationS: 10 });
    expect(second.status).toBe(409);
  });

  it("enforces the cooldown after a completed run", async () => {
    const { id } = await makeGateway();
    await Device.updateOne({ _id: id }, { $set: { "actuators.cooldownS": 900 } });

    const first = await spray(tokenA, id, { durationS: 10 });
    // Simulate the gateway having run and acked it a minute ago.
    await ActuatorCommand.updateOne(
      { _id: first.body.data.command.id },
      {
        $set: {
          status: "acked",
          ackedAt: new Date(Date.now() - 60 * 1000),
          result: { executed: true, actualRuntimeS: 10 },
        },
      }
    );

    const second = await spray(tokenA, id, { durationS: 10 });
    expect(second.status).toBe(429);
    expect(second.body.error?.message || second.body.message).toMatch(/cooldown/i);
  });

  it("enforces the rolling daily budget", async () => {
    const { id } = await makeGateway();
    await Device.updateOne(
      { _id: id },
      { $set: { "actuators.cooldownS": 0, "actuators.dailyBudgetS": 60, "actuators.maxRuntimeS": 60 } }
    );

    const first = await spray(tokenA, id, { durationS: 50 });
    await ActuatorCommand.updateOne(
      { _id: first.body.data.command.id },
      {
        $set: {
          status: "acked",
          ackedAt: new Date(Date.now() - 60 * 1000),
          result: { executed: true, actualRuntimeS: 50 },
        },
      }
    );

    const second = await spray(tokenA, id, { durationS: 50 });
    expect(second.status).toBe(429);
    expect(second.body.error?.message || second.body.message).toMatch(/budget/i);
  });

  it("treats cooldownS 0 as no cooldown rather than as unset", async () => {
    // Zero has to mean zero: the schema allows min 0, and if it silently fell
    // back to the 15 min site default there would be no way to configure a
    // fast-cycling plot at all.
    const { id } = await makeGateway();
    await Device.updateOne({ _id: id }, { $set: { "actuators.cooldownS": 0 } });

    const first = await spray(tokenA, id, { durationS: 10 });
    await ActuatorCommand.updateOne(
      { _id: first.body.data.command.id },
      {
        $set: {
          status: "acked",
          ackedAt: new Date(Date.now() - 1000),
          result: { executed: true, actualRuntimeS: 10 },
        },
      }
    );

    expect((await spray(tokenA, id, { durationS: 10 })).status).toBe(202);
  });

  it("treats dailyBudgetS 0 as allowing no water at all", async () => {
    const { id } = await makeGateway();
    await Device.updateOne({ _id: id }, { $set: { "actuators.dailyBudgetS": 0 } });

    const res = await spray(tokenA, id, { durationS: 10 });
    expect(res.status).toBe(429);
    expect(res.body.error?.message || res.body.message).toMatch(/budget/i);
  });
});

describe("environmental veto", () => {
  it("refuses to spray when the plot is already saturated", async () => {
    const { id, deviceKey } = await makeGateway({ plot: "Veto Plot A" });
    await Device.updateOne({ _id: id }, { $set: { "thresholds.soilSaturatedPct": 85 } });

    await ingest(deviceKey, { soilMoisturePct: 92 });

    const res = await spray(tokenA, id, { durationS: 10 });
    expect(res.status).toBe(409);
    expect(res.body.error?.message || res.body.message).toMatch(/waterlog|saturat/i);
  });

  it("refuses to spray while it is raining", async () => {
    const { id, deviceKey } = await makeGateway({ plot: "Veto Plot B" });
    await ingest(deviceKey, { soilMoisturePct: 20, rainDetected: true });

    const res = await spray(tokenA, id, { durationS: 10 });
    expect(res.status).toBe(409);
    expect(res.body.error?.message || res.body.message).toMatch(/rain/i);
  });

  it("does NOT veto when there is no soil reading at all", async () => {
    // A camera-only gateway legitimately has no probe. Absent data must not be
    // read as "wet", or the feature is unusable on the rig it was built for.
    const { id } = await makeGateway({ plot: "Veto Plot C" });
    const res = await spray(tokenA, id, { durationS: 10 });
    expect(res.status).toBe(202);
  });
});

describe("delivery to the gateway", () => {
  it("rides the ingest response and flips the command to sent", async () => {
    const { id, deviceKey } = await makeGateway();
    const queued = await spray(tokenA, id, { durationS: 25 });
    const commandId = queued.body.data.command.id;

    const res = await ingest(deviceKey);
    expect(res.status).toBe(201);
    expect(Array.isArray(res.body.data.commands)).toBe(true);

    const delivered = res.body.data.commands.find((c) => c.id === commandId);
    expect(delivered).toBeDefined();
    expect(delivered.actuator).toBe("sprinkler");
    expect(delivered.action).toBe("on");
    expect(delivered.durationS).toBe(25);
    // remainingS, not an absolute expiry — the gateway's clock is untrusted.
    expect(delivered.remainingS).toBeGreaterThan(0);
    expect(delivered.expiresAt).toBeUndefined();

    const stored = await ActuatorCommand.findById(commandId);
    expect(stored.status).toBe("sent");
    expect(stored.sentAt).toBeTruthy();
  });

  it("also rides GET /config so a rebooting gateway picks it up", async () => {
    const { id, deviceKey } = await makeGateway();
    await spray(tokenA, id, { durationS: 15 });

    const res = await request(app)
      .get("/api/telemetry/config")
      .set("X-Device-Key", deviceKey);

    expect(res.status).toBe(200);
    expect(res.body.data.commands).toHaveLength(1);
  });

  it("re-delivers a still-live command that was never acked", async () => {
    // The ingest response can be lost on the way back to a marginal link;
    // delivering exactly once would turn that into a spray that never happened.
    const { id, deviceKey } = await makeGateway();
    await spray(tokenA, id, { durationS: 15 });

    await ingest(deviceKey);
    const second = await ingest(deviceKey);
    expect(second.body.data.commands).toHaveLength(1);
  });

  it("never delivers an expired command", async () => {
    const { id, deviceKey } = await makeGateway();
    const queued = await spray(tokenA, id, { durationS: 15 });

    // The gateway was offline past the TTL — the farmer's intent described
    // conditions that no longer hold, so this must die rather than fire late.
    await ActuatorCommand.updateOne(
      { _id: queued.body.data.command.id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } }
    );

    const res = await ingest(deviceKey);
    expect(res.body.data.commands).toHaveLength(0);

    const stored = await ActuatorCommand.findById(queued.body.data.command.id);
    expect(stored.status).toBe("expired");
  });

  it("gives a device with nothing queued an empty array", async () => {
    const { deviceKey } = await makeGateway();
    const res = await ingest(deviceKey);
    expect(res.body.data.commands).toEqual([]);
  });
});

describe("acknowledgement", () => {
  it("records what the gateway actually ran", async () => {
    const { id, deviceKey } = await makeGateway();
    const queued = await spray(tokenA, id, { durationS: 30 });
    const commandId = queued.body.data.command.id;
    await ingest(deviceKey);

    const res = await request(app)
      .post(`/api/telemetry/commands/${commandId}/ack`)
      .set("X-Device-Key", deviceKey)
      .send({ executed: true, actualRuntimeS: 28 });

    expect(res.status).toBe(200);

    const stored = await ActuatorCommand.findById(commandId);
    expect(stored.status).toBe("acked");
    // 28, not the requested 30 — a watchdog cut is normal and the budget must
    // count the water that actually moved.
    expect(stored.result.actualRuntimeS).toBe(28);
  });

  it("records a refusal as failed rather than acked", async () => {
    const { id, deviceKey } = await makeGateway();
    const queued = await spray(tokenA, id, { durationS: 30 });
    await ingest(deviceKey);

    await request(app)
      .post(`/api/telemetry/commands/${queued.body.data.command.id}/ack`)
      .set("X-Device-Key", deviceKey)
      .send({ executed: false, error: "relay not enabled in firmware" });

    const stored = await ActuatorCommand.findById(queued.body.data.command.id);
    expect(stored.status).toBe("failed");
    expect(stored.result.error).toMatch(/relay not enabled/);
  });

  it("cannot be acked with another device's key", async () => {
    const { id } = await makeGateway();
    const other = await makeGateway();
    const queued = await spray(tokenA, id, { durationS: 30 });

    const res = await request(app)
      .post(`/api/telemetry/commands/${queued.body.data.command.id}/ack`)
      .set("X-Device-Key", other.deviceKey)
      .send({ executed: true, actualRuntimeS: 30 });

    expect(res.status).toBe(404);
  });

  it("requires a device key, not a user token", async () => {
    const { id } = await makeGateway();
    const queued = await spray(tokenA, id, { durationS: 30 });

    const res = await request(app)
      .post(`/api/telemetry/commands/${queued.body.data.command.id}/ack`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ executed: true });

    expect(res.status).toBe(401);
  });
});

describe("stop", () => {
  it("queues a stop that bypasses the cooldown", async () => {
    const { id } = await makeGateway();
    await Device.updateOne({ _id: id }, { $set: { "actuators.cooldownS": 3600 } });

    const started = await spray(tokenA, id, { durationS: 60 });
    await ActuatorCommand.updateOne(
      { _id: started.body.data.command.id },
      { $set: { status: "acked", ackedAt: new Date(), result: { executed: true, actualRuntimeS: 5 } } }
    );

    // Cooldown would refuse a new spray here, but a stop is never refused —
    // the reasons not to START water are not reasons to refuse to stop it.
    const res = await request(app)
      .post(`/api/telemetry/devices/${id}/spray/stop`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send();

    expect(res.status).toBe(202);
    expect(res.body.data.command.action).toBe("off");
  });

  it("cancels any command still in flight", async () => {
    const { id } = await makeGateway();
    const queued = await spray(tokenA, id, { durationS: 60 });

    await request(app)
      .post(`/api/telemetry/devices/${id}/spray/stop`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send();

    const stored = await ActuatorCommand.findById(queued.body.data.command.id);
    expect(stored.status).toBe("cancelled");
  });
});

describe("history and provenance", () => {
  it("stores the detection that motivated the spray", async () => {
    const { id } = await makeGateway();
    const res = await spray(tokenA, id, {
      durationS: 30,
      source: "pest_detection",
      label: "Chilli_Whitefly",
      confidence: 91.2,
      pestName: "Silverleaf whitefly",
      category: "pest",
    });

    expect(res.status).toBe(202);
    const stored = await ActuatorCommand.findById(res.body.data.command.id);
    expect(stored.reason.source).toBe("pest_detection");
    expect(stored.reason.label).toBe("Chilli_Whitefly");
    expect(stored.reason.pestName).toBe("Silverleaf whitefly");
    expect(stored.reason.confidence).toBeCloseTo(91.2);
  });

  it("lists a user's commands and never another user's", async () => {
    const { id } = await makeGateway();
    await spray(tokenA, id, { durationS: 10 });

    const mine = await request(app)
      .get("/api/telemetry/commands")
      .set("Authorization", `Bearer ${tokenA}`);
    expect(mine.status).toBe(200);
    expect(mine.body.data.length).toBeGreaterThan(0);

    const theirs = await request(app)
      .get("/api/telemetry/commands")
      .set("Authorization", `Bearer ${tokenB}`);
    const leaked = theirs.body.data.filter((c) => String(c.deviceId) === String(id));
    expect(leaked).toHaveLength(0);
  });

  it("reports cooldown and budget state for the dashboard control", async () => {
    const { id } = await makeGateway();
    const res = await request(app)
      .get(`/api/telemetry/devices/${id}/actuator`)
      .set("Authorization", `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      sprinklerEnabled: true,
      busy: false,
      dailyBudgetS: expect.any(Number),
      maxRuntimeS: expect.any(Number),
    });
    expect(res.body.data.cooldownRemainingS).toBe(0);
  });
});

describe("configuration sanity", () => {
  it("keeps the command TTL short enough that a stale command cannot fire", () => {
    // The whole safety argument rests on a command dying before the world has
    // moved on. If someone raises this to an hour, the interlocks stop meaning
    // anything — so the assumption is asserted, not just documented.
    expect(config.actuatorCommandTtlS).toBeLessThanOrEqual(600);
    expect(config.actuatorMaxRuntimeS).toBeLessThanOrEqual(600);
  });
});

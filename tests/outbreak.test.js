import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { createFakeModel } from "./setup/fakeModels.js";

// Nearby-disease (outbreak) alerts. Runs without a database: the models,
// socket and push sender are replaced by in-memory fakes.

const Device = createFakeModel("Device");
const OutbreakAlert = createFakeModel("OutbreakAlert");
const User = createFakeModel("User");
const UserPreferences = createFakeModel("UserPreferences");
const emitted = [];
const pushed = [];

jest.unstable_mockModule("../src/modules/telemetry/device.model.js", () => ({ default: Device }));
jest.unstable_mockModule("../src/modules/telemetry/outbreak.model.js", () => ({
  default: OutbreakAlert,
}));
jest.unstable_mockModule("../src/modules/user/user.model.js", () => ({ default: User }));
jest.unstable_mockModule("../src/modules/chat/chat.models.js", () => ({ UserPreferences }));
jest.unstable_mockModule("../src/modules/chat/socket.js", () => ({
  emitToUser: (room, event, data) => emitted.push({ room, event, data }),
}));
jest.unstable_mockModule("../src/shared/utils/pushSender.js", () => ({
  sendPushToUser: async (token, message) => {
    pushed.push({ token, ...message });
    return { tickets: [] };
  },
}));

const outbreak = await import("../src/modules/telemetry/outbreak.service.js");
const {
  coordsOf,
  distanceKm,
  proximity,
  isOutbreakWorthy,
  roundedKm,
  serializeOutbreak,
  pushTextFor,
  sourceLocationOf,
  raiseOutbreakAlerts,
  listOutbreaks,
  dismissOutbreak,
} = outbreak;

// Gorakhpur; 1 km north is ~0.008983 degrees of latitude.
const BASE = { lat: 26.7606, lon: 83.3732 };
const north = (km) => ({ latitude: BASE.lat + km / 111.32, longitude: BASE.lon });
const at = (km, extra = {}) => ({ ...north(km), district: "Gorakhpur", state: "Uttar Pradesh", ...extra });

const id = () => new mongoose.Types.ObjectId();

const analysisOf = (overrides = {}) => ({
  _id: id(),
  status: "completed",
  crop: "cassava",
  detection: {
    disease: "Cassava_bacterial_blight",
    diseaseTitle: "Cassava Bacterial Blight (CBB)",
    confidence: 72.4,
    status: "grounded",
    ...(overrides.detection || {}),
  },
  ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "detection")),
});

describe("pure helpers", () => {
  it("coordsOf rejects missing, out-of-range and (0,0) positions", () => {
    expect(coordsOf({ latitude: 26.7, longitude: 83.3 })).toEqual({ lat: 26.7, lon: 83.3 });
    expect(coordsOf({ latitude: 26.7 })).toBeNull();
    expect(coordsOf({})).toBeNull();
    expect(coordsOf(null)).toBeNull();
    expect(coordsOf({ latitude: 0, longitude: 0 })).toBeNull();
    expect(coordsOf({ latitude: 95, longitude: 10 })).toBeNull();
    expect(coordsOf({ latitude: "x", longitude: 10 })).toBeNull();
  });

  it("distanceKm is a sane haversine", () => {
    const a = { lat: BASE.lat, lon: BASE.lon };
    expect(distanceKm(a, a)).toBe(0);
    const d = distanceKm(a, { lat: north(3).latitude, lon: BASE.lon });
    expect(d).toBeGreaterThan(2.95);
    expect(d).toBeLessThan(3.05);
    // Gorakhpur to Lucknow is roughly 250-270 km in a straight line
    const lucknow = distanceKm(a, { lat: 26.8467, lon: 80.9462 });
    expect(lucknow).toBeGreaterThan(230);
    expect(lucknow).toBeLessThan(280);
  });

  it("proximity: GPS on both sides decides by distance alone", () => {
    expect(proximity(at(0), at(4.9), 5)).toMatchObject({ matchedBy: "distance" });
    // same district, but GPS says 12 km: not a neighbour
    expect(proximity(at(0), at(12), 5)).toBeNull();
  });

  it("proximity: falls back to district (case/space-insensitive), checks state when known", () => {
    const noGps = { district: " gorakhpur ", state: "uttar pradesh" };
    expect(proximity(at(0), noGps, 5)).toEqual({ matchedBy: "district", distanceKm: null });
    expect(proximity(at(0), { district: "Gorakhpur", state: "Bihar" }, 5)).toBeNull();
    expect(proximity(at(0), { district: "Deoria" }, 5)).toBeNull();
    expect(proximity(at(0), { district: "Gorakhpur" }, 5)).toMatchObject({ matchedBy: "district" });
  });

  it("proximity: nothing known means not near, except for the farmer's own plots", () => {
    expect(proximity({}, {}, 5)).toBeNull();
    expect(proximity({}, {}, 5, { sameOwner: true })).toEqual({ matchedBy: "same_farm", distanceKm: null });
    expect(proximity(at(0), at(9), 5, { sameOwner: true })).toBeNull();
  });

  it("isOutbreakWorthy only passes confident, grounded, non-healthy results", () => {
    expect(isOutbreakWorthy(analysisOf(), 60)).toBe(true);
    expect(isOutbreakWorthy(analysisOf({ detection: { confidence: 59.9 } }), 60)).toBe(false);
    expect(isOutbreakWorthy(analysisOf({ detection: { confidence: 60 } }), 60)).toBe(true);
    expect(isOutbreakWorthy(analysisOf({ detection: { confidence: 26.3 } }), 60)).toBe(false);
    expect(isOutbreakWorthy(analysisOf({ detection: { status: "unavailable" } }), 60)).toBe(false);
    expect(isOutbreakWorthy(analysisOf({ detection: { status: "healthy" } }), 60)).toBe(false);
    expect(isOutbreakWorthy(analysisOf({ detection: { disease: "Tomato___healthy" } }), 60)).toBe(false);
    expect(isOutbreakWorthy(analysisOf({ action: { category: "healthy" } }), 60)).toBe(false);
    expect(isOutbreakWorthy(analysisOf({ status: "failed" }), 60)).toBe(false);
    expect(isOutbreakWorthy(analysisOf({ detection: { confidence: undefined } }), 60)).toBe(false);
    expect(isOutbreakWorthy(null, 60)).toBe(false);
  });

  it("roundedKm never reveals sub-kilometre distance", () => {
    expect(roundedKm(0.2)).toBe(1);
    expect(roundedKm(2.6)).toBe(3);
    expect(roundedKm(null)).toBeNull();
    expect(roundedKm(NaN)).toBeNull();
  });

  it("sourceLocationOf prefers the camera, then its gateway, then the owner profile", () => {
    expect(sourceLocationOf({ location: at(1) }, { location: at(0) }, null)).toMatchObject({
      latitude: at(1).latitude,
      district: "Gorakhpur",
    });
    expect(sourceLocationOf({ location: {} }, { location: at(0) }, null)).toMatchObject({
      latitude: at(0).latitude,
    });
    expect(sourceLocationOf({}, {}, { district: "Deoria", state: "UP" })).toEqual({
      latitude: undefined,
      longitude: undefined,
      district: "Deoria",
      state: "UP",
    });
  });

  it("a neighbour's alert never carries the reporting farm's identifiers", () => {
    const row = {
      _id: id(),
      scope: "nearby_farm",
      sourceOwner: id(),
      sourceDevice: id(),
      sourceCapture: id(),
      analysis: id(),
      sourceNodeLabel: "plot-a-cam",
      sourcePlot: "North field",
      disease: "Cassava_bacterial_blight",
      confidence: 72.44,
      distanceKm: 2.6,
      matchedBy: "distance",
      affectedPlots: ["My plot"],
      createdAt: new Date(),
    };
    const out = serializeOutbreak(row);
    expect(out).toMatchObject({ scope: "nearby_farm", distanceKm: 3, confidence: 72 });
    const text = JSON.stringify(out);
    for (const secret of [row.sourceOwner, row.sourceDevice, row.sourceCapture, row.analysis]) {
      expect(text).not.toContain(String(secret));
    }
    expect(text).not.toContain("plot-a-cam");
    expect(text).not.toContain("North field");
    expect(out).not.toHaveProperty("deviceId");
    expect(out).not.toHaveProperty("captureId");

    const own = serializeOutbreak({ ...row, scope: "own_plot" });
    expect(own).toMatchObject({ nodeLabel: "plot-a-cam", plot: "North field" });
    expect(String(own.captureId)).toBe(String(row.sourceCapture));
  });

  it("push text", () => {
    const near = pushTextFor({ scope: "nearby_farm", disease: "leaf_rust", crop: "wheat", distanceKm: 2.4 });
    expect(near.title).toBe("Disease reported near your farm");
    expect(near.body).toBe(
      "Leaf Rust was found on a farm about 2 km from your farm. Check your wheat for early signs over the next few days."
    );
    expect(pushTextFor({ scope: "nearby_farm", disease: "x", distanceKm: null }).body).toContain("in your district");
    const own = pushTextFor({
      scope: "own_plot",
      diseaseTitle: "Cassava Bacterial Blight (CBB)",
      sourcePlot: "A",
      affectedPlots: ["B", "C"],
    });
    expect(own.body).toBe(
      "Cassava Bacterial Blight (CBB) was detected on plot A. Check your nearby plots too: B, C."
    );
  });
});

// ---------------------------------------------------------------------------
// raiseOutbreakAlerts against an in-memory world
// ---------------------------------------------------------------------------

let owner, camera, gateway, world;

function buildWorld() {
  const users = {
    owner: { _id: id(), district: "Gorakhpur", state: "Uttar Pradesh", pushToken: "ExponentPushToken[owner]" },
    near3: { _id: id(), district: "Gorakhpur", state: "Uttar Pradesh", pushToken: "ExponentPushToken[near3]" },
    far12: { _id: id(), district: "Gorakhpur", state: "Uttar Pradesh", pushToken: "ExponentPushToken[far12]" },
    noGpsDevice: { _id: id(), district: "Gorakhpur", pushToken: null },
    profileOnly: { _id: id(), district: "gorakhpur", state: "Uttar Pradesh", pushToken: "ExponentPushToken[profile]" },
    otherDistrict: { _id: id(), district: "Deoria", pushToken: "ExponentPushToken[deoria]" },
    muted: { _id: id(), district: "Gorakhpur", pushToken: "ExponentPushToken[muted]" },
    inactive: { _id: id(), district: "Gorakhpur", pushToken: "ExponentPushToken[inactive]" },
  };

  const dev = (who, fields) => ({ _id: id(), owner: users[who]._id, isActive: true, type: "sensor", ...fields });

  const devices = {
    camera: dev("owner", { name: "Plot A camera", nodeLabel: "plot-a-cam", type: "camera", plot: "A", crop: "cassava", location: at(0) }),
    gateway: dev("owner", { name: "Gateway", nodeLabel: "gw", type: "gateway", location: at(0) }),
    sameplot: dev("owner", { name: "Plot A soil", nodeLabel: "plot-a-soil", plot: " a ", location: at(0.1) }),
    plotB: dev("owner", { name: "B soil", nodeLabel: "plot-b-soil", plot: "B", location: at(0.5) }),
    plotC: dev("owner", { name: "C soil", nodeLabel: "plot-c-soil", plot: "C", location: at(8) }),
    plotD: dev("owner", { name: "D soil", nodeLabel: "plot-d-soil", plot: "D" }),
    unnamed: dev("owner", { name: "Spare", nodeLabel: "spare", location: at(0.2) }),

    near3: dev("near3", { name: "Rice soil", nodeLabel: "rice", plot: "Paddy 1", location: at(3) }),
    near3gw: dev("near3", { name: "Their gateway", nodeLabel: "gw2", type: "gateway", location: at(3.2) }),
    far12: dev("far12", { name: "Far", nodeLabel: "far", location: at(12) }),
    noGpsDevice: dev("noGpsDevice", { name: "Shed sensor", nodeLabel: "shed", location: { district: "GORAKHPUR" } }),
    profileOnly: dev("profileOnly", { name: "Field 7", nodeLabel: "f7" }),
    otherDistrict: dev("otherDistrict", { name: "Deoria plot", nodeLabel: "d1", location: { district: "Deoria" } }),
    muted: dev("muted", { name: "Muted plot", nodeLabel: "m1", location: at(2) }),
    inactive: dev("inactive", { name: "Old", nodeLabel: "old", isActive: false, location: at(1) }),
  };

  User.reset(Object.values(users));
  Device.reset(Object.values(devices));
  // reset() gives fresh _ids only to docs without one; ours already have them.
  UserPreferences.reset([
    { userId: users.muted._id, notificationPreferences: { pest_alerts: false } },
    { userId: users.near3._id, notificationPreferences: { pest_alerts: true } },
  ]);
  OutbreakAlert.reset();
  emitted.length = 0;
  pushed.length = 0;

  return { users, devices };
}

const capture = () => ({ _id: id(), nodeLabel: "plot-a-cam" });

beforeEach(() => {
  world = buildWorld();
  owner = world.users.owner;
  camera = world.devices.camera;
  gateway = world.devices.gateway;
});

const recipientsOf = () => OutbreakAlert.rows.map((row) => String(row.recipient));

describe("raiseOutbreakAlerts", () => {
  it("alerts the owner's other plots and nearby farms, and nobody else", async () => {
    const result = await raiseOutbreakAlerts({
      capture: capture(),
      analysis: analysisOf(),
      sourceDevice: camera,
      gateway,
    });

    const { users } = world;
    const got = new Set(recipientsOf());
    expect(result.created).toBe(got.size);
    expect(got).toEqual(
      new Set([users.owner, users.near3, users.noGpsDevice, users.profileOnly, users.muted].map((u) => String(u._id)))
    );

    const own = OutbreakAlert.rows.find((row) => row.scope === "own_plot");
    // B is 0.5 km away; D has no GPS but the owner's district matches.
    // A is the camera's own plot (" a " normalised), C is 8 km away, the
    // unnamed sensor cannot be told apart from plot A.
    expect([...own.affectedPlots].sort()).toEqual(["B", "D"]);
    expect(own.matchedBy).toBe("distance");
    expect(own.sourcePlot).toBe("A");

    const near = OutbreakAlert.rows.find((row) => String(row.recipient) === String(users.near3._id));
    expect(near.scope).toBe("nearby_farm");
    expect(near.matchedBy).toBe("distance");
    expect(near.distanceKm).toBeGreaterThan(2.9);
    expect(near.distanceKm).toBeLessThan(3.1);
    // their gateway is evidence of location but is not listed as a plot
    expect(near.affectedPlots).toEqual(["Paddy 1"]);
    expect(near.crop).toBe("cassava");
    expect(near.confidence).toBe(72.4);

    const byDistrict = OutbreakAlert.rows.find((row) => String(row.recipient) === String(users.noGpsDevice._id));
    expect(byDistrict).toMatchObject({ matchedBy: "district", distanceKm: null, district: "Gorakhpur" });
  });

  it("emits one live event per recipient, with neighbours' payloads stripped", async () => {
    const cap = capture();
    await raiseOutbreakAlerts({ capture: cap, analysis: analysisOf(), sourceDevice: camera, gateway });

    expect(emitted.every((e) => e.event === "outbreak_alert")).toBe(true);
    expect(new Set(emitted.map((e) => e.room))).toEqual(new Set(recipientsOf()));

    for (const event of emitted.filter((e) => e.data.scope === "nearby_farm")) {
      const text = JSON.stringify(event.data);
      expect(text).not.toContain(String(owner._id));
      expect(text).not.toContain(String(camera._id));
      expect(text).not.toContain(String(cap._id));
      expect(text).not.toContain("plot-a-cam");
    }
    const ownEvent = emitted.find((e) => e.data.scope === "own_plot");
    expect(String(ownEvent.data.captureId)).toBe(String(cap._id));
  });

  it("pushes to recipients with a token who have not muted pest alerts", async () => {
    await raiseOutbreakAlerts({ capture: capture(), analysis: analysisOf(), sourceDevice: camera, gateway });
    expect(pushed.map((p) => p.token).sort()).toEqual(
      ["ExponentPushToken[near3]", "ExponentPushToken[owner]", "ExponentPushToken[profile]"].sort()
    );
    expect(pushed.every((p) => p.data.kind === "outbreak_alert")).toBe(true);
    // the muted user still gets the dashboard alert
    expect(recipientsOf()).toContain(String(world.users.muted._id));
  });

  it("does not repeat the same disease from the same farm inside the cooldown", async () => {
    const args = () => ({ capture: capture(), analysis: analysisOf(), sourceDevice: camera, gateway });
    const first = await raiseOutbreakAlerts(args());
    expect(first.created).toBeGreaterThan(0);
    emitted.length = 0;
    pushed.length = 0;

    const second = await raiseOutbreakAlerts(args());
    expect(second.created).toBe(0);
    expect(emitted).toHaveLength(0);
    expect(pushed).toHaveLength(0);

    // a second camera on the same farm: neighbours are not told again, but
    // the owner's own-plot alert is per camera
    const otherCam = { ...camera, _id: id(), nodeLabel: "plot-b-cam", plot: "B", location: at(0.5) };
    const third = await raiseOutbreakAlerts({ ...args(), sourceDevice: otherCam });
    expect(third.created).toBe(1);
    expect(OutbreakAlert.rows.at(-1).scope).toBe("own_plot");
  });

  it("a different disease is a new alert; an expired cooldown alerts again", async () => {
    await raiseOutbreakAlerts({ capture: capture(), analysis: analysisOf(), sourceDevice: camera, gateway });
    const before = OutbreakAlert.rows.length;

    const rust = analysisOf({ detection: { disease: "Leaf_rust", diseaseTitle: "Leaf rust" } });
    const res = await raiseOutbreakAlerts({ capture: capture(), analysis: rust, sourceDevice: camera, gateway });
    expect(res.created).toBe(before);

    // age every stored alert past the 24 h cooldown
    OutbreakAlert.rows.forEach((row) => (row.createdAt = new Date(Date.now() - 25 * 3600 * 1000)));
    const again = await raiseOutbreakAlerts({ capture: capture(), analysis: analysisOf(), sourceDevice: camera, gateway });
    expect(again.created).toBe(before);
  });

  it("does nothing for low-confidence, unmatched or healthy results", async () => {
    for (const analysis of [
      analysisOf({ detection: { confidence: 26.3 } }),
      analysisOf({ detection: { status: "unavailable" } }),
      analysisOf({ detection: { status: "healthy", disease: "healthy" } }),
    ]) {
      const res = await raiseOutbreakAlerts({ capture: capture(), analysis, sourceDevice: camera, gateway });
      expect(res.created).toBe(0);
    }
    expect(OutbreakAlert.rows).toHaveLength(0);
    expect(Device.calls).toHaveLength(0); // gated before any query
  });

  it("with no location anywhere: own plots still alerted, no neighbours", async () => {
    const strip = (d) => ({ ...d, location: undefined });
    Device.reset(Object.values(world.devices).map(strip));
    User.reset(Object.values(world.users).map((u) => ({ ...u, district: undefined, state: undefined })));

    const res = await raiseOutbreakAlerts({
      capture: capture(),
      analysis: analysisOf(),
      sourceDevice: strip(camera),
      gateway: strip(gateway),
    });
    expect(res.created).toBe(1);
    const [only] = OutbreakAlert.rows;
    expect(only.scope).toBe("own_plot");
    expect(only.matchedBy).toBe("same_farm");
    expect([...only.affectedPlots].sort()).toEqual(["B", "C", "D"]);
  });

  it("a farmer with one plot and no neighbours gets nothing extra", async () => {
    Device.reset([camera, gateway]);
    const res = await raiseOutbreakAlerts({ capture: capture(), analysis: analysisOf(), sourceDevice: camera, gateway });
    expect(res).toEqual({ created: 0 });
  });

  it("never throws: a database error is logged and reported", async () => {
    Device.failNext("find", new Error("connection reset"));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      raiseOutbreakAlerts({ capture: capture(), analysis: analysisOf(), sourceDevice: camera, gateway })
    ).resolves.toMatchObject({ created: 0, error: "connection reset" });
    spy.mockRestore();
  });

  it("a failing push does not stop the others or the dashboard alerts", async () => {
    const pushModule = await import("../src/shared/utils/pushSender.js");
    expect(typeof pushModule.sendPushToUser).toBe("function");
    // make the owner's token throw inside the mocked sender
    User.rows.find((u) => String(u._id) === String(owner._id)).pushToken = "boom";
    const original = pushed.push.bind(pushed);
    pushed.push = (entry) => {
      if (entry.token === "boom") throw new Error("expo down");
      return original(entry);
    };
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await raiseOutbreakAlerts({ capture: capture(), analysis: analysisOf(), sourceDevice: camera, gateway });
    spy.mockRestore();
    pushed.push = original;
    expect(res.created).toBe(5);
    expect(pushed.map((p) => p.token)).toContain("ExponentPushToken[near3]");
  });
});

describe("listOutbreaks / dismissOutbreak", () => {
  it("lists only the caller's recent, undismissed alerts, newest first", async () => {
    const me = id();
    const someoneElse = id();
    const day = 24 * 3600 * 1000;
    OutbreakAlert.reset([
      { recipient: me, scope: "nearby_farm", disease: "a", matchedBy: "distance", distanceKm: 2, createdAt: new Date(Date.now() - 2 * day), sourceOwner: id(), sourceDevice: id() },
      { recipient: me, scope: "nearby_farm", disease: "b", matchedBy: "district", createdAt: new Date(Date.now() - 1000), sourceOwner: id(), sourceDevice: id() },
      { recipient: me, scope: "nearby_farm", disease: "old", matchedBy: "district", createdAt: new Date(Date.now() - 20 * day) },
      { recipient: me, scope: "nearby_farm", disease: "gone", matchedBy: "district", createdAt: new Date(), dismissedAt: new Date() },
      { recipient: someoneElse, scope: "nearby_farm", disease: "theirs", matchedBy: "district", createdAt: new Date() },
    ]);
    const list = await listOutbreaks(me, { limit: "10" });
    expect(list.map((a) => a.disease)).toEqual(["b", "a"]);
    expect(list[0]).not.toHaveProperty("sourceOwner");
    expect(await listOutbreaks(me, { limit: 1 })).toHaveLength(1);
  });

  it("dismiss only works on your own alert", async () => {
    const me = id();
    OutbreakAlert.reset([{ recipient: me, scope: "own_plot", disease: "a", matchedBy: "same_farm", createdAt: new Date() }]);
    const [row] = OutbreakAlert.rows;

    await expect(dismissOutbreak(id(), row._id)).rejects.toMatchObject({ status: 404 });
    expect(row.dismissedAt).toBeFalsy();

    const res = await dismissOutbreak(me, row._id);
    expect(res.dismissedAt).toBeInstanceOf(Date);
    expect(await listOutbreaks(me)).toHaveLength(0);
  });
});

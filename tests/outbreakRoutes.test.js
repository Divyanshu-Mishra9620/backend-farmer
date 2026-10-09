import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { createFakeModel } from "./setup/fakeModels.js";

// HTTP surface of nearby-disease alerts (GET /outbreaks, POST /outbreaks/:id/
// dismiss) with the alert store in memory, so it runs without a database.

const OutbreakAlert = createFakeModel("OutbreakAlert");

jest.unstable_mockModule("../src/modules/telemetry/outbreak.model.js", () => ({
  default: OutbreakAlert,
}));
jest.unstable_mockModule("../src/modules/chat/socket.js", () => ({
  emitToUser: () => {},
}));

const { default: router } = await import("../src/modules/telemetry/telemetry.routes.js");
const { default: errorHandler } = await import("../src/shared/middlewares/errorHandler.js");
const { default: config } = await import("../src/config/env.js");

const app = express();
app.use(express.json());
app.use("/api/telemetry", router);
app.use(errorHandler);

const oid = () => new mongoose.Types.ObjectId();
const me = oid();
const other = oid();
const tokenFor = (userId) =>
  jwt.sign({ id: String(userId), role: "user" }, config.jwtSecret, { algorithm: "HS256" });

beforeEach(() => {
  OutbreakAlert.reset([
    {
      recipient: me,
      scope: "nearby_farm",
      sourceOwner: other,
      sourceDevice: oid(),
      sourceCapture: oid(),
      sourceNodeLabel: "their-cam",
      disease: "Cassava_bacterial_blight",
      diseaseTitle: "Cassava Bacterial Blight (CBB)",
      crop: "cassava",
      confidence: 72.4,
      matchedBy: "distance",
      distanceKm: 2.6,
      affectedPlots: ["Paddy 1"],
      createdAt: new Date(),
    },
    {
      recipient: other,
      scope: "own_plot",
      disease: "Leaf_rust",
      matchedBy: "same_farm",
      createdAt: new Date(),
    },
  ]);
});

describe("GET /api/telemetry/outbreaks", () => {
  it("requires a login", async () => {
    const res = await request(app).get("/api/telemetry/outbreaks");
    expect(res.status).toBe(401);
  });

  it("returns only the caller's alerts, without the reporter's identity", async () => {
    const res = await request(app)
      .get("/api/telemetry/outbreaks")
      .set("Authorization", `Bearer ${tokenFor(me)}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(1);
    const [alert] = res.body.data;
    expect(alert).toMatchObject({
      scope: "nearby_farm",
      diseaseTitle: "Cassava Bacterial Blight (CBB)",
      distanceKm: 3,
      confidence: 72,
      affectedPlots: ["Paddy 1"],
    });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(String(other));
    expect(text).not.toContain("their-cam");
    expect(alert.captureId).toBeUndefined();
  });

  it("validates limit", async () => {
    const res = await request(app)
      .get("/api/telemetry/outbreaks?limit=500")
      .set("Authorization", `Bearer ${tokenFor(me)}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /api/telemetry/outbreaks/:id/dismiss", () => {
  it("dismisses the caller's alert, which then drops out of the list", async () => {
    const [mine] = OutbreakAlert.rows;
    const res = await request(app)
      .post(`/api/telemetry/outbreaks/${mine._id}/dismiss`)
      .set("Authorization", `Bearer ${tokenFor(me)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.dismissedAt).toBeTruthy();

    const list = await request(app)
      .get("/api/telemetry/outbreaks")
      .set("Authorization", `Bearer ${tokenFor(me)}`);
    expect(list.body.data).toHaveLength(0);
  });

  it("404s on someone else's alert and leaves it alone", async () => {
    const theirs = OutbreakAlert.rows[1];
    const res = await request(app)
      .post(`/api/telemetry/outbreaks/${theirs._id}/dismiss`)
      .set("Authorization", `Bearer ${tokenFor(me)}`);
    expect(res.status).toBe(404);
    expect(theirs.dismissedAt).toBeFalsy();
  });

  it("400s on a malformed id", async () => {
    const res = await request(app)
      .post("/api/telemetry/outbreaks/not-an-id/dismiss")
      .set("Authorization", `Bearer ${tokenFor(me)}`);
    expect(res.status).toBe(400);
  });
});

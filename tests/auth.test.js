import request from "supertest";
import mongoose from "mongoose";
import expressLoader from "../src/loaders/express.js";
import { connectTestDB, disconnectTestDB } from "./setup/testDb.js";
import { testUserPayload } from "./setup/factories.js";
import User from "../src/modules/user/user.model.js";

let app;
const createdEmails = [];

beforeAll(async () => {
  await connectTestDB();
  app = await expressLoader();
});

afterAll(async () => {
  await User.deleteMany({ email: { $in: createdEmails } });
  await disconnectTestDB();
});

describe("POST /api/auth/signup", () => {
  it("registers a new user", async () => {
    const payload = testUserPayload();
    createdEmails.push(payload.email);

    const res = await request(app).post("/api/auth/signup").send(payload);

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(payload.email);
    expect(res.body.user.password).toBeUndefined();
  });

  it("rejects a duplicate email with 409 CONFLICT", async () => {
    const payload = testUserPayload();
    createdEmails.push(payload.email);
    await request(app).post("/api/auth/signup").send(payload);

    const res = await request(app).post("/api/auth/signup").send(payload);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });

  it("rejects an incomplete payload with 400", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "incomplete@example.com" });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/login", () => {
  const payload = testUserPayload();

  beforeAll(async () => {
    createdEmails.push(payload.email);
    await request(app).post("/api/auth/signup").send(payload);
  });

  it("logs in with correct credentials", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: payload.email, password: payload.password });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
  });

  it("rejects the wrong password with 401, not 500", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: payload.email, password: "WrongPassword123!" });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects a nonexistent email with 401 (no user-enumeration leak)", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody-such-user@example.com", password: "whatever123" });

    expect(res.status).toBe(401);
    // Same message as wrong-password, not a distinct "user not found" —
    // an attacker must not be able to tell which case occurred.
    const wrongPassRes = await request(app)
      .post("/api/auth/login")
      .send({ email: payload.email, password: "WrongPassword123!" });
    expect(res.body.error.message).toBe(wrongPassRes.body.error.message);
  });
});

describe("POST /api/auth/refresh and /api/auth/logout", () => {
  const payload = testUserPayload();
  let accessToken;
  let refreshToken;

  beforeAll(async () => {
    createdEmails.push(payload.email);
    await request(app).post("/api/auth/signup").send(payload);
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: payload.email, password: payload.password });
    accessToken = loginRes.body.accessToken;
    refreshToken = loginRes.body.refreshToken;
  });

  it("issues a new access token for a valid refresh token", async () => {
    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  it("rejects a malformed refresh token with 401, not 500", async () => {
    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: "not-a-real-token" });

    expect(res.status).toBe(401);
  });

  it("logs out and invalidates the stored refresh token", async () => {
    const res = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);

    const user = await User.findOne({ email: payload.email });
    expect(user.refreshToken).toBeNull();
  });
});

describe("GET /api/auth/profile", () => {
  it("rejects a request with no token with 401", async () => {
    const res = await request(app).get("/api/auth/profile");
    expect(res.status).toBe(401);
  });

  it("returns the profile for a valid token", async () => {
    const payload = testUserPayload();
    createdEmails.push(payload.email);
    await request(app).post("/api/auth/signup").send(payload);
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: payload.email, password: payload.password });

    const res = await request(app)
      .get("/api/auth/profile")
      .set("Authorization", `Bearer ${loginRes.body.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.email).toBe(payload.email);
  });
});

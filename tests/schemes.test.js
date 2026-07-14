import request from "supertest";
import expressLoader from "../src/loaders/express.js";
import { connectTestDB, disconnectTestDB } from "./setup/testDb.js";
import { testUserPayload } from "./setup/factories.js";
import User from "../src/modules/user/user.model.js";

let app;
let regularUserToken;
const createdEmails = [];

beforeAll(async () => {
  await connectTestDB();
  app = await expressLoader();

  const payload = testUserPayload();
  createdEmails.push(payload.email);
  await request(app).post("/api/auth/signup").send(payload);
  const loginRes = await request(app)
    .post("/api/auth/login")
    .send({ email: payload.email, password: payload.password });
  regularUserToken = loginRes.body.accessToken;
});

afterAll(async () => {
  await User.deleteMany({ email: { $in: createdEmails } });
  await disconnectTestDB();
});

describe("GET /api/schemes", () => {
  it("is publicly readable with no auth token", async () => {
    const res = await request(app).get("/api/schemes");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.schemes)).toBe(true);
  });
});

describe("admin-only scheme mutations", () => {
  it("rejects a non-admin user creating a scheme with 403, not 401 or 500", async () => {
    const res = await request(app)
      .post("/api/schemes")
      .set("Authorization", `Bearer ${regularUserToken}`)
      .send({ sector: "test", titles: { en: "Test Scheme" } });

    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated request to create a scheme with 401", async () => {
    const res = await request(app)
      .post("/api/schemes")
      .send({ sector: "test", titles: { en: "Test Scheme" } });

    expect(res.status).toBe(401);
  });
});

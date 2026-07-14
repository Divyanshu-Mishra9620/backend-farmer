import request from "supertest";
import expressLoader from "../src/loaders/express.js";
import { connectTestDB, disconnectTestDB } from "./setup/testDb.js";
import { testUserPayload } from "./setup/factories.js";
import User from "../src/modules/user/user.model.js";

let app;
let accessToken;
const createdEmails = [];
const FAKE_ID = "507f1f77bcf86cd799439011";
const MALFORMED_ID = "not-a-valid-id";

beforeAll(async () => {
  await connectTestDB();
  app = await expressLoader();

  const payload = testUserPayload();
  createdEmails.push(payload.email);
  await request(app).post("/api/auth/signup").send(payload);
  const loginRes = await request(app)
    .post("/api/auth/login")
    .send({ email: payload.email, password: payload.password });
  accessToken = loginRes.body.accessToken;
});

afterAll(async () => {
  await User.deleteMany({ email: { $in: createdEmails } });
  await disconnectTestDB();
});

describe("disease detection error handling", () => {
  it("returns 400 VALIDATION_ERROR for a malformed analysis id, not a raw 500", async () => {
    const res = await request(app)
      .get(`/api/disease-detection/${MALFORMED_ID}`)
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 404 NOT_FOUND for a well-formed but nonexistent analysis id", async () => {
    const res = await request(app)
      .get(`/api/disease-detection/${FAKE_ID}`)
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 (not a status-string-matching 500) when retrying a nonexistent analysis", async () => {
    const res = await request(app)
      .post(`/api/disease-detection/${FAKE_ID}/retry`)
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when deleting a nonexistent analysis", async () => {
    const res = await request(app)
      .delete(`/api/disease-detection/${FAKE_ID}`)
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("rejects an unauthenticated request with 401", async () => {
    const res = await request(app).get(`/api/disease-detection/${FAKE_ID}`);
    expect(res.status).toBe(401);
  });
});

describe("disease detection happy paths not requiring the AI pipeline", () => {
  it("lists analyses for the current user (empty)", async () => {
    const res = await request(app)
      .get("/api/disease-detection")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("returns stats for the current user", async () => {
    const res = await request(app)
      .get("/api/disease-detection/stats/summary")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ total: 0, completed: 0, failed: 0 });
  });
});

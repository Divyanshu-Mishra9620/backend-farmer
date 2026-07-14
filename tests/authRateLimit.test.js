import request from "supertest";
import expressLoader from "../src/loaders/express.js";
import { connectTestDB, disconnectTestDB } from "./setup/testDb.js";

// authLimiter caps unauthenticated login attempts at 10 per 15 minutes per
// IP (src/shared/middlewares/rateLimiter.js). This file is isolated from
// every other test file specifically so its request count against
// /api/auth/login isn't shared with (and thrown off by) other suites —
// Jest gives each test file its own module registry, so this limiter
// instance's in-memory counter starts fresh at 10 here.
describe("login rate limiting", () => {
  let app;

  beforeAll(async () => {
    await connectTestDB();
    app = await expressLoader();
  });

  afterAll(disconnectTestDB);

  it("returns 429 once the 15-minute attempt cap is exceeded", async () => {
    const credentials = { email: "rate-limit-probe@example.com", password: "wrong" };
    let lastStatus;

    for (let i = 0; i < 11; i += 1) {
      const res = await request(app).post("/api/auth/login").send(credentials);
      lastStatus = res.status;
    }

    expect(lastStatus).toBe(429);
  }, 30000);
});

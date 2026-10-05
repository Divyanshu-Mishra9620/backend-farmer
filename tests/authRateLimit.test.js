import request from "supertest";
import expressLoader from "../src/loaders/express.js";
import { connectTestDB, disconnectTestDB } from "./setup/testDb.js";

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

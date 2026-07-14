import request from "supertest";
import expressLoader from "../src/loaders/express.js";
import { connectTestDB, disconnectTestDB } from "./setup/testDb.js";
import { testUserPayload } from "./setup/factories.js";
import User from "../src/modules/user/user.model.js";
import VoiceChat from "../src/modules/voiceChat/voiceChat.model.js";

let app;
let accessToken;
let userId;
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
  accessToken = loginRes.body.accessToken;
  userId = loginRes.body.user._id;
});

afterAll(async () => {
  await VoiceChat.deleteMany({ userId });
  await User.deleteMany({ email: { $in: createdEmails } });
  await disconnectTestDB();
});

describe("voice chat error handling", () => {
  it("starts a voice session", async () => {
    const res = await request(app)
      .post("/api/voice-chat/start-session")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ language: "hindi" });

    expect(res.status).toBe(200);
    expect(res.body.data.sessionId).toBeTruthy();
  });

  it("returns 400 (not 500) when processing audio with no sessionId", async () => {
    const res = await request(app)
      .post("/api/voice-chat/process-audio")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ audioData: Buffer.alloc(2000).toString("base64") });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when ending a session with no sessionId", async () => {
    const res = await request(app)
      .post("/api/voice-chat/end-session")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it("ending a nonexistent session does not error (idempotent no-op)", async () => {
    const res = await request(app)
      .post("/api/voice-chat/end-session")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ sessionId: "nonexistent-session-id" });

    expect(res.status).toBe(200);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const res = await request(app).get("/api/voice-chat/history");
    expect(res.status).toBe(401);
  });

  it("returns voice chat history for the current user", async () => {
    const res = await request(app)
      .get("/api/voice-chat/history")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    // The "starts a voice session" test above already created one session
    // for this same user, so history is non-empty by this point.
    expect(res.body.data.voiceChats.length).toBeGreaterThanOrEqual(1);
  });
});

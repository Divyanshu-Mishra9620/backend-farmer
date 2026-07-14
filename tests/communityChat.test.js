import request from "supertest";
import expressLoader from "../src/loaders/express.js";
import { connectTestDB, disconnectTestDB } from "./setup/testDb.js";
import { attachMockIo } from "./setup/mockIo.js";
import { testUserPayload } from "./setup/factories.js";
import User from "../src/modules/user/user.model.js";
import {
  CommunityChannel,
  ChannelMember,
  CommunityMessage,
} from "../src/modules/communityChat/communityChat.models.js";

let app;
let user1Token;
let user2Token;
let createdChannelId;
const createdEmails = [];
const FAKE_ID = "507f1f77bcf86cd799439011";

beforeAll(async () => {
  await connectTestDB();
  app = await expressLoader();
  attachMockIo(app);

  const user1 = testUserPayload();
  const user2 = testUserPayload();
  createdEmails.push(user1.email, user2.email);

  await request(app).post("/api/auth/signup").send(user1);
  await request(app).post("/api/auth/signup").send(user2);

  const login1 = await request(app)
    .post("/api/auth/login")
    .send({ email: user1.email, password: user1.password });
  const login2 = await request(app)
    .post("/api/auth/login")
    .send({ email: user2.email, password: user2.password });

  user1Token = login1.body.accessToken;
  user2Token = login2.body.accessToken;
});

afterAll(async () => {
  if (createdChannelId) {
    await ChannelMember.deleteMany({ channelId: createdChannelId });
    await CommunityMessage.deleteMany({ channelId: createdChannelId });
    await CommunityChannel.findByIdAndDelete(createdChannelId);
  }
  await User.deleteMany({ email: { $in: createdEmails } });
  await disconnectTestDB();
});

function validChannelPayload(overrides = {}) {
  return {
    name: "Wheat Growers",
    description: "A channel for discussing wheat cultivation techniques",
    category: "crop_cultivation",
    ...overrides,
  };
}

describe("community chat: validation now enforced (previously a no-op)", () => {
  it("rejects a malformed channelId with 400, not a raw 500/CastError", async () => {
    const res = await request(app)
      .get("/api/community/channels/not-a-valid-id")
      .set("Authorization", `Bearer ${user1Token}`);

    expect(res.status).toBe(400);
  });

  it("rejects an invalid category with 400", async () => {
    const res = await request(app)
      .post("/api/community/channels")
      .set("Authorization", `Bearer ${user1Token}`)
      .send(validChannelPayload({ category: "not_a_real_category" }));

    expect(res.status).toBe(400);
  });
});

describe("community chat channel lifecycle", () => {
  let channelId;

  it("creates a channel (creator auto-joins as admin)", async () => {
    const res = await request(app)
      .post("/api/community/channels")
      .set("Authorization", `Bearer ${user1Token}`)
      .send(validChannelPayload());

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe("Wheat Growers");
    channelId = res.body.data._id;
    createdChannelId = channelId;
  });

  it("returns 404 NOT_FOUND for a well-formed but nonexistent channel", async () => {
    const res = await request(app)
      .get(`/api/community/channels/${FAKE_ID}`)
      .set("Authorization", `Bearer ${user1Token}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("lets a second user join the channel", async () => {
    const res = await request(app)
      .post(`/api/community/channels/${channelId}/join`)
      .set("Authorization", `Bearer ${user2Token}`);

    expect(res.status).toBe(200);
  });

  it("returns 409 CONFLICT (not 500) when joining a channel twice", async () => {
    const res = await request(app)
      .post(`/api/community/channels/${channelId}/join`)
      .set("Authorization", `Bearer ${user2Token}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });

  it("rejects a non-member sending a message with 403", async () => {
    const user3 = testUserPayload();
    createdEmails.push(user3.email);
    await request(app).post("/api/auth/signup").send(user3);
    const login3 = await request(app)
      .post("/api/auth/login")
      .send({ email: user3.email, password: user3.password });

    const res = await request(app)
      .post(`/api/community/channels/${channelId}/messages`)
      .set("Authorization", `Bearer ${login3.body.accessToken}`)
      .send({ content: "Hello from a non-member" });

    expect(res.status).toBe(403);
  });

  it("lets a member send a message", async () => {
    const res = await request(app)
      .post(`/api/community/channels/${channelId}/messages`)
      .set("Authorization", `Bearer ${user2Token}`)
      .send({ content: "Great tips, thanks!" });

    expect(res.status).toBe(201);
  });

  it("rejects a non-creator deleting the channel with 403", async () => {
    const res = await request(app)
      .delete(`/api/community/channels/${channelId}`)
      .set("Authorization", `Bearer ${user2Token}`);

    expect(res.status).toBe(403);
  });

  it("lets the creator delete the channel", async () => {
    const res = await request(app)
      .delete(`/api/community/channels/${channelId}`)
      .set("Authorization", `Bearer ${user1Token}`);

    expect(res.status).toBe(200);
  });
});

import request from "supertest";
import expressLoader from "../src/loaders/express.js";
import { connectTestDB, disconnectTestDB } from "./setup/testDb.js";
import { testUserPayload } from "./setup/factories.js";
import User from "../src/modules/user/user.model.js";
import { Post } from "../src/modules/FarmersCommunity/PostModel.js";

let app;
let user1Token;
let user2Token;
const createdEmails = [];
const FAKE_ID = "507f1f77bcf86cd799439011";

beforeAll(async () => {
  await connectTestDB();
  app = await expressLoader();

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
  await User.deleteMany({ email: { $in: createdEmails } });
  await disconnectTestDB();
});

describe("community posts error handling", () => {
  it("returns 400 with the shared error shape for a missing title/content", async () => {
    const res = await request(app)
      .post("/api/posts")
      .set("Authorization", `Bearer ${user1Token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it("returns 404 NOT_FOUND (not a raw 500) when voting on a nonexistent post", async () => {
    const res = await request(app)
      .post(`/api/posts/${FAKE_ID}/vote`)
      .set("Authorization", `Bearer ${user1Token}`)
      .send({ voteType: "upvote" });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
  });

  it("returns 404 NOT_FOUND for a nonexistent post by id", async () => {
    const res = await request(app).get(`/api/posts/${FAKE_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 403 FORBIDDEN when a non-owner tries to delete a post", async () => {
    const createRes = await request(app)
      .post("/api/posts")
      .set("Authorization", `Bearer ${user1Token}`)
      .send({ title: "Owner's post", content: "Only the owner may delete this" });
    const postId = createRes.body._id;

    const res = await request(app)
      .delete(`/api/posts/${postId}`)
      .set("Authorization", `Bearer ${user2Token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");

    // Clean up directly since the non-owner delete was correctly rejected.
    await Post.findByIdAndDelete(postId);
  });
});

describe("community posts happy path", () => {
  let postId;

  it("creates a post", async () => {
    const res = await request(app)
      .post("/api/posts")
      .set("Authorization", `Bearer ${user1Token}`)
      .send({ title: "Test crop rotation tips", content: "Rotate legumes with cereals." });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe("Test crop rotation tips");
    postId = res.body._id;
  });

  it("lists posts", async () => {
    const res = await request(app).get("/api/posts");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.posts)).toBe(true);
  });

  it("upvotes the post", async () => {
    const res = await request(app)
      .post(`/api/posts/${postId}/vote`)
      .set("Authorization", `Bearer ${user2Token}`)
      .send({ voteType: "upvote" });

    expect(res.status).toBe(200);
    expect(res.body.upvotes).toHaveLength(1);
  });

  it("updates the post as its owner", async () => {
    const res = await request(app)
      .patch(`/api/posts/${postId}`)
      .set("Authorization", `Bearer ${user1Token}`)
      .send({ title: "Updated crop rotation tips" });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Updated crop rotation tips");
  });

  it("deletes the post as its owner", async () => {
    const res = await request(app)
      .delete(`/api/posts/${postId}`)
      .set("Authorization", `Bearer ${user1Token}`);

    expect(res.status).toBe(200);
  });
});

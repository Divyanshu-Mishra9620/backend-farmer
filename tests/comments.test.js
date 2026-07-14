import request from "supertest";
import expressLoader from "../src/loaders/express.js";
import { connectTestDB, disconnectTestDB } from "./setup/testDb.js";
import { testUserPayload } from "./setup/factories.js";
import User from "../src/modules/user/user.model.js";
import { Post } from "../src/modules/FarmersCommunity/PostModel.js";
import { Comment } from "../src/modules/FarmersCommunity/CommentModel.js";

let app;
let user1Token;
let user2Token;
let postId;
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

  const postRes = await request(app)
    .post("/api/posts")
    .set("Authorization", `Bearer ${user1Token}`)
    .send({ title: "Comment test post", content: "Testing comment error paths" });
  postId = postRes.body._id;
});

afterAll(async () => {
  await Comment.deleteMany({ post: postId });
  await Post.findByIdAndDelete(postId);
  await User.deleteMany({ email: { $in: createdEmails } });
  await disconnectTestDB();
});

describe("comment error handling", () => {
  it("returns 404 for a comment on a nonexistent post", async () => {
    const res = await request(app)
      .post(`/api/comments/${FAKE_ID}/comments`)
      .set("Authorization", `Bearer ${user1Token}`)
      .send({ message: "Hello" });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("creates a comment on a real post", async () => {
    const res = await request(app)
      .post(`/api/comments/${postId}/comments`)
      .set("Authorization", `Bearer ${user1Token}`)
      .send({ message: "Nice post!" });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe("Nice post!");
  });

  it("rejects a non-author editing a comment with 403", async () => {
    const createRes = await request(app)
      .post(`/api/comments/${postId}/comments`)
      .set("Authorization", `Bearer ${user1Token}`)
      .send({ message: "Owner comment" });
    const commentId = createRes.body._id;

    const res = await request(app)
      .put(`/api/comments/${commentId}`)
      .set("Authorization", `Bearer ${user2Token}`)
      .send({ message: "Hijacked edit" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("returns 404 for deleting a nonexistent comment", async () => {
    const res = await request(app)
      .delete(`/api/comments/${FAKE_ID}`)
      .set("Authorization", `Bearer ${user1Token}`);

    expect(res.status).toBe(404);
  });
});

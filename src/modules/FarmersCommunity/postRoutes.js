import { Router } from "express";
import { param, body } from "express-validator";
import {
  createPost,
  getAllPosts,
  getPostById,
  updatePost,
  deletePost,
  votePost,
} from "./postController.js";

import { authMiddleware as auth } from "../../shared/middlewares/authMiddleware.js";
import upload from "../../shared/middlewares/uploadMiddleware.js";
import validateRequest from "../../shared/middlewares/expressValidatorCheck.js";

const router = Router();

const postIdParam = param("postId").isMongoId().withMessage("Invalid post ID");
const voteValidation = body("voteType")
  .isIn(["upvote", "downvote", "none"])
  .withMessage("voteType must be upvote, downvote, or none");
const postBodyValidation = [
  body("title")
    .trim()
    .isLength({ min: 1, max: 150 })
    .withMessage("Title must be between 1 and 150 characters"),
  body("content")
    .trim()
    .isLength({ min: 1, max: 5000 })
    .withMessage("Content must be between 1 and 5000 characters"),
];
const postUpdateValidation = [
  body("title")
    .optional()
    .trim()
    .isLength({ min: 1, max: 150 })
    .withMessage("Title must be between 1 and 150 characters"),
  body("content")
    .optional()
    .trim()
    .isLength({ min: 1, max: 5000 })
    .withMessage("Content must be between 1 and 5000 characters"),
];

router.get("/", getAllPosts);
router.post(
  "/",
  auth,
  upload.single("image"),
  postBodyValidation,
  validateRequest,
  createPost
);
router.get("/:postId", postIdParam, validateRequest, getPostById);
router.patch(
  "/:postId",
  auth,
  postIdParam,
  postUpdateValidation,
  validateRequest,
  updatePost
);
router.delete("/:postId", auth, postIdParam, validateRequest, deletePost);
router.post(
  "/:postId/vote",
  auth,
  postIdParam,
  voteValidation,
  validateRequest,
  votePost
);

export default router;

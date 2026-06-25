import { Router } from "express";
import { param, body } from "express-validator";
import {
  deleteComment,
  voteComment,
  getCommentsForPost,
  createComment,
  editComment,
} from "./commentController.js";
import { authMiddleware as auth } from "../../shared/middlewares/authMiddleware.js";
import validateRequest from "../../shared/middlewares/expressValidatorCheck.js";

const router = Router();

const postIdParam = param("postId").isMongoId().withMessage("Invalid post ID");
const commentIdParam = param("commentId")
  .isMongoId()
  .withMessage("Invalid comment ID");
const messageValidation = body("message")
  .trim()
  .isLength({ min: 1, max: 1000 })
  .withMessage("Comment message must be between 1 and 1000 characters");
const voteValidation = body("voteType")
  .isIn(["upvote", "downvote", "none"])
  .withMessage("voteType must be upvote, downvote, or none");

router.post(
  "/:postId/comments",
  auth,
  postIdParam,
  messageValidation,
  validateRequest,
  createComment
);
router.delete("/:commentId", auth, commentIdParam, validateRequest, deleteComment);
router.post(
  "/:commentId/vote",
  auth,
  commentIdParam,
  voteValidation,
  validateRequest,
  voteComment
);
router.get("/:postId/comments", postIdParam, validateRequest, getCommentsForPost);
router.put(
  "/:commentId",
  auth,
  commentIdParam,
  messageValidation,
  validateRequest,
  editComment
);

export default router;

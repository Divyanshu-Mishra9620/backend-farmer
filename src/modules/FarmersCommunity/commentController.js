import { Comment } from "./CommentModel.js";
import { Post } from "./PostModel.js";
import httpError from "../../shared/utils/httpError.js";

export const getCommentsForPost = async (req, res, next) => {
  try {
    const { postId } = req.params;

    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const skip = (page - 1) * limit;

    const comments = await Comment.find({ post: postId })
      .populate("author", "name email")
      .sort({ createdAt: "asc" })
      .skip(skip)
      .limit(limit);

    const totalComments = await Comment.countDocuments({ post: postId });

    res.status(200).json({
      comments,
      totalPages: Math.ceil(totalComments / limit),
      currentPage: page,
    });
  } catch (error) {
    next(error);
  }
};

export const createComment = async (req, res, next) => {
  try {
    const { postId } = req.params;
    const { message, imageUrl, parentCommentId } = req.body;
    const authorId = req.user.id;

    if (!message) {
      throw httpError(400, "Comment message cannot be empty");
    }

    const postExists = await Post.exists({ _id: postId });
    if (!postExists) {
      throw httpError(404, "Post not found");
    }

    const newComment = new Comment({
      author: authorId,
      post: postId,
      parentComment: parentCommentId || null,
      message,
      imageUrl,
    });

    await newComment.save();
    const populatedComment = await Comment.findById(newComment._id).populate(
      "author",
      "name email"
    );

    res.status(201).json(populatedComment);
  } catch (error) {
    next(error);
  }
};

export const deleteComment = async (req, res, next) => {
  try {
    const { commentId } = req.params;
    const userId = req.user.id;

    const comment = await Comment.findById(commentId);
    if (!comment) {
      throw httpError(404, "Comment not found");
    }

    if (comment.author.toString() !== userId) {
      throw httpError(403, "You are not authorized to delete this comment");
    }

    comment.isDeleted = true;
    comment.message = "[deleted]";
    await comment.save();

    res.status(200).json({ message: "Comment deleted successfully", comment });
  } catch (error) {
    next(error);
  }
};

export const editComment = async (req, res, next) => {
  try {
    const { commentId } = req.params;
    const { message } = req.body;
    const userId = req.user.id;

    const comment = await Comment.findById(commentId);

    if (!comment) {
      throw httpError(404, "Comment not found");
    }

    if (comment.author.toString() !== userId) {
      throw httpError(403, "You can only edit your own comments");
    }

    comment.message = message;
    await comment.save();

    const updatedComment = await Comment.findById(commentId).populate(
      "author",
      "name"
    );

    res.status(200).json(updatedComment);
  } catch (error) {
    next(error);
  }
};

export const voteComment = async (req, res, next) => {
  try {
    const { commentId } = req.params;
    const { voteType } = req.body;
    const userId = req.user.id;

    let updateQuery = {};
    if (voteType === "upvote") {
      updateQuery = {
        $addToSet: { upvotes: userId },
        $pull: { downvotes: userId },
      };
    } else if (voteType === "downvote") {
      updateQuery = {
        $addToSet: { downvotes: userId },
        $pull: { upvotes: userId },
      };
    } else if (voteType === "none") {
      updateQuery = { $pull: { upvotes: userId, downvotes: userId } };
    } else {
      throw httpError(400, "Invalid vote type");
    }

    const updatedComment = await Comment.findByIdAndUpdate(
      commentId,
      updateQuery,
      { new: true }
    ).populate("author", "name email");

    if (!updatedComment) {
      throw httpError(404, "Comment not found");
    }

    res.status(200).json(updatedComment);
  } catch (error) {
    next(error);
  }
};

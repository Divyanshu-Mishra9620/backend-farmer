import { Comment } from "./CommentModel.js";
import { Post } from "./PostModel.js";
import { safeErrorMessage } from "../../shared/utils/safeError.js";

export const getCommentsForPost = async (req, res) => {
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
    res
      .status(500)
      .json({ message: "Error fetching comments", error: safeErrorMessage(error) });
  }
};

export const createComment = async (req, res) => {
  try {
    const { postId } = req.params;
    const { message, imageUrl, parentCommentId } = req.body;
    const authorId = req.user.id;

    if (!message) {
      return res
        .status(400)
        .json({ message: "Comment message cannot be empty" });
    }

    const postExists = await Post.exists({ _id: postId });
    if (!postExists) {
      return res.status(404).json({ message: "Post not found" });
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
    res
      .status(500)
      .json({ message: "Error creating comment", error: safeErrorMessage(error) });
  }
};

export const deleteComment = async (req, res) => {
  try {
    const { commentId } = req.params;
    const userId = req.user.id;

    const comment = await Comment.findById(commentId);
    if (!comment) {
      return res.status(404).json({ message: "Comment not found" });
    }

    if (comment.author.toString() !== userId) {
      return res
        .status(403)
        .json({ message: "You are not authorized to delete this comment" });
    }

    comment.isDeleted = true;
    comment.message = "[deleted]";
    await comment.save();

    res.status(200).json({ message: "Comment deleted successfully", comment });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error deleting comment", error: safeErrorMessage(error) });
  }
};

export const editComment = async (req, res) => {
  try {
    const { commentId } = req.params;
    const { message } = req.body;
    const userId = req.user.id;

    const comment = await Comment.findById(commentId);

    if (!comment) {
      return res.status(404).json({ message: "Comment not found" });
    }

    if (comment.author.toString() !== userId) {
      return res
        .status(403)
        .json({ message: "Forbidden: You can only edit your own comments" });
    }

    comment.message = message;
    await comment.save();

    const updatedComment = await Comment.findById(commentId).populate(
      "author",
      "name"
    );

    res.status(200).json(updatedComment);
  } catch (error) {
    console.error("Error editing comment:", error);
    res.status(500).json({ message: "Internal Server error" });
  }
};

export const voteComment = async (req, res) => {
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
      return res.status(400).json({ message: "Invalid vote type" });
    }

    const updatedComment = await Comment.findByIdAndUpdate(
      commentId,
      updateQuery,
      { new: true }
    ).populate("author", "name email");

    if (!updatedComment) {
      return res.status(404).json({ message: "Comment not found" });
    }

    res.status(200).json(updatedComment);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error voting on comment", error: safeErrorMessage(error) });
  }
};

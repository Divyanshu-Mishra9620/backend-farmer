import { Post } from "./PostModel.js";
import { Comment } from "./CommentModel.js";
import mongoose from "mongoose";
import httpError from "../../shared/utils/httpError.js";
import { resolveUploadedImageUrl } from "../../shared/utils/imageUrl.js";

export const createPost = async (req, res, next) => {
  try {
    const { title, content } = req.body;
    const authorId = req.user.id;

    if (!title || !content) {
      throw httpError(400, "Title and content are required");
    }

    const imageUrl = await resolveUploadedImageUrl(
      req.file,
      "community-posts",
    );

    const newPost = new Post({
      author: authorId,
      title,
      content,
      imageUrl,
    });

    await newPost.save();
    const populatedPost = await Post.findById(newPost._id).populate(
      "author",
      "name email",
    );
    res.status(201).json({ ...populatedPost.toObject(), commentCount: 0 });
  } catch (error) {
    next(error);
  }
};

export const getAllPosts = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const skip = (page - 1) * limit;

    const posts = await Post.find()
      .populate("author", "name email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const postIds = posts.map((post) => post._id);
    const commentCounts = await Comment.aggregate([
      { $match: { post: { $in: postIds } } },
      { $group: { _id: "$post", count: { $sum: 1 } } },
    ]);
    const countByPostId = new Map(
      commentCounts.map(({ _id, count }) => [_id.toString(), count]),
    );

    const totalPosts = await Post.countDocuments();

    res.status(200).json({
      posts: posts.map((post) => ({
        ...post.toObject(),
        commentCount: countByPostId.get(post._id.toString()) || 0,
      })),
      totalPages: Math.ceil(totalPosts / limit),
      currentPage: page,
    });
  } catch (error) {
    next(error);
  }
};

export const votePost = async (req, res, next) => {
  try {
    const { postId } = req.params;
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

    const updatedPost = await Post.findByIdAndUpdate(postId, updateQuery, {
      new: true,
    }).populate("author", "name email");

    if (!updatedPost) {
      throw httpError(404, "Post not found");
    }

    const commentCount = await Comment.countDocuments({ post: postId });
    res.status(200).json({ ...updatedPost.toObject(), commentCount });
  } catch (error) {
    next(error);
  }
};

export const deletePost = async (req, res, next) => {
  try {
    const { postId } = req.params;
    const userId = req.user.id;

    const post = await Post.findById(postId);
    if (!post) {
      throw httpError(404, "Post not found");
    }

    if (post.author.toString() !== userId) {
      throw httpError(403, "You are not authorized to delete this post");
    }

    await Comment.deleteMany({ post: postId });

    await Post.findByIdAndDelete(postId);

    res.status(200).json({
      message: "Post and all associated comments deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};

export const updatePost = async (req, res, next) => {
  try {
    const { postId } = req.params;
    const { title, content, imageUrl } = req.body;
    const userId = req.user.id;

    const post = await Post.findById(postId);
    if (!post) {
      throw httpError(404, "Post not found");
    }

    if (post.author.toString() !== userId) {
      throw httpError(403, "You are not authorized to edit this post");
    }

    const updates = {};
    if (title !== undefined) updates.title = title;
    if (content !== undefined) updates.content = content;
    if (imageUrl !== undefined) updates.imageUrl = imageUrl;

    const updatedPost = await Post.findByIdAndUpdate(postId, updates, {
      new: true,
      runValidators: true,
    }).populate("author", "name email");

    const commentCount = await Comment.countDocuments({ post: postId });
    res.status(200).json({ ...updatedPost.toObject(), commentCount });
  } catch (error) {
    next(error);
  }
};

export const getPostById = async (req, res, next) => {
  try {
    const { postId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(postId)) {
      throw httpError(400, "Invalid Post ID");
    }

    const post = await Post.findById(postId).populate("author", "name email");
    if (!post) {
      throw httpError(404, "Post not found");
    }

    res.status(200).json(post);
  } catch (error) {
    next(error);
  }
};

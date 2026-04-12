import mongoose from "mongoose";

const postSchema = new mongoose.Schema(
  {
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    content: {
      type: String,
      required: true,
    },
    imageUrl: {
      type: String,
      default: null,
    },
    upvotes: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    downvotes: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

postSchema.virtual("score").get(function () {
  return this.upvotes.length - this.downvotes.length;
});

postSchema.virtual("commentCount", {
  ref: "Comment",
  localField: "_id",
  foreignField: "post",
  count: true,
});

// Also populate comment count when toJSON/toObject is called for fallback
postSchema.post("save", async function (doc) {
  const Comment = mongoose.model("Comment");
  if (Comment) {
    doc.commentCount = await Comment.countDocuments({ post: doc._id });
  }
});

postSchema.post("find", async function (docs) {
  const Comment = mongoose.model("Comment");
  if (Comment && docs && Array.isArray(docs)) {
    for (let doc of docs) {
      doc.commentCount = await Comment.countDocuments({ post: doc._id });
    }
  }
});

postSchema.post("findOne", async function (doc) {
  const Comment = mongoose.model("Comment");
  if (Comment && doc) {
    doc.commentCount = await Comment.countDocuments({ post: doc._id });
  }
});

export const Post = mongoose.model("Post", postSchema);

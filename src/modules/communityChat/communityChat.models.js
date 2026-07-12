import mongoose from "mongoose";

const channelSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
      maxlength: 50,
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    category: {
      type: String,
      enum: [
        "crop_cultivation",
        "pest_management",
        "weather_discussion",
        "market_prices",
        "farming_techniques",
        "equipment_tools",
        "organic_farming",
        "government_schemes",
        "general_discussion",
      ],
      required: true,
    },
    icon: {
      type: String,
      default: "🌾",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    moderators: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    memberCount: {
      type: Number,
      default: 0,
    },
    messageCount: {
      type: Number,
      default: 0,
    },
    lastActivity: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

const communityMessageSchema = new mongoose.Schema(
  {
    channelId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CommunityChannel",
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    content: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: "",
    },
    messageType: {
      type: String,
      enum: ["text", "image", "link", "poll"],
      default: "text",
    },
    attachments: [
      {
        type: {
          type: String,
          enum: ["image", "document"],
        },
        url: String,
        filename: String,
        size: Number,
      },
    ],
    mentions: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    reactions: [
      {
        userId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        emoji: {
          type: String,
          enum: ["👍", "❤️", "😊", "👏", "🤔", "😢"],
        },
      },
    ],
    replies: [
      {
        userId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        content: {
          type: String,
          maxlength: 500,
        },
        createdAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    isEdited: {
      type: Boolean,
      default: false,
    },
    editedAt: Date,
    isDeleted: {
      type: Boolean,
      default: false,
    },
    isPinned: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

const channelMemberSchema = new mongoose.Schema(
  {
    channelId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CommunityChannel",
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    role: {
      type: String,
      enum: ["member", "moderator", "admin"],
      default: "member",
    },
    joinedAt: {
      type: Date,
      default: Date.now,
    },
    lastSeen: {
      type: Date,
      default: Date.now,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    messageCount: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

const communityAnalyticsSchema = new mongoose.Schema(
  {
    channelId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CommunityChannel",
      required: true,
    },
    date: {
      type: Date,
      required: true,
    },
    activeUsers: {
      type: Number,
      default: 0,
    },
    messagesCount: {
      type: Number,
      default: 0,
    },
    newMembers: {
      type: Number,
      default: 0,
    },
    engagementScore: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

channelSchema.index({ category: 1, isActive: 1 });
channelSchema.index({ lastActivity: -1 });
channelSchema.index({ memberCount: -1 });

communityMessageSchema.index({ channelId: 1, createdAt: -1 });
communityMessageSchema.index({ userId: 1 });
communityMessageSchema.index({ content: "text" });

channelMemberSchema.index({ channelId: 1, userId: 1 }, { unique: true });
channelMemberSchema.index({ userId: 1 });

communityAnalyticsSchema.index({ channelId: 1, date: 1 }, { unique: true });

communityMessageSchema.virtual("reactionCounts").get(function () {
  const counts = {};
  this.reactions.forEach((reaction) => {
    counts[reaction.emoji] = (counts[reaction.emoji] || 0) + 1;
  });
  return counts;
});

communityMessageSchema.virtual("replyCount").get(function () {
  return this.replies.length;
});

export const CommunityChannel = mongoose.model(
  "CommunityChannel",
  channelSchema
);
export const CommunityMessage = mongoose.model(
  "CommunityMessage",
  communityMessageSchema
);
export const ChannelMember = mongoose.model(
  "ChannelMember",
  channelMemberSchema
);
export const CommunityAnalytics = mongoose.model(
  "CommunityAnalytics",
  communityAnalyticsSchema
);

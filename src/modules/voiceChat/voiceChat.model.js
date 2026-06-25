import mongoose from "mongoose";

const conversationSchema = new mongoose.Schema({
  userAudio: {
    type: String,
    required: true,
  },
  userText: {
    type: String,
    required: true,
  },
  aiText: {
    type: String,
    required: true,
  },
  aiAudio: {
    type: String,
    required: true,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
});

const voiceChatSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    sessionId: {
      type: String,
      required: true,
      unique: true,
    },
    language: {
      type: String,
      enum: ["hindi", "english"],
      default: "hindi",
    },
    status: {
      type: String,
      enum: ["active", "completed", "expired"],
      default: "active",
    },
    conversations: [conversationSchema],
    lastActivity: {
      type: Date,
      default: Date.now,
    },
    endTime: {
      type: Date,
    },
  },
  {
    timestamps: true,
  },
);

voiceChatSchema.index({ userId: 1, createdAt: -1 });

export default mongoose.model("VoiceChat", voiceChatSchema);

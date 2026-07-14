import mongoose from "mongoose";

const conversationSchema = new mongoose.Schema(
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
      index: true,
    },
    messages: [
      {
        role: {
          type: String,
          enum: ["user", "assistant", "system"],
          required: true,
        },
        content: {
          type: String,
          required: true,
        },
        timestamp: {
          type: Date,
          default: Date.now,
        },
        metadata: {
          type: mongoose.Schema.Types.Mixed,
          default: {},
        },
      },
    ],
    context: {
      crop: String,
      location: {
        address: String,
        coordinates: {
          lat: Number,
          lon: Number,
        },
        state: String,
        district: String,
      },
      weather: {
        type: mongoose.Schema.Types.Mixed,
      },
      soilAnalysis: {
        type: mongoose.Schema.Types.Mixed,
      },
      marketData: {
        type: mongoose.Schema.Types.Mixed,
      },
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    lastActivity: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  },
);

conversationSchema.index({ userId: 1, lastActivity: -1 });

conversationSchema.pre("save", function (next) {
  if (this.isModified("messages")) {
    this.lastActivity = new Date();
  }
  next();
});

const feedbackSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
    },
    messageIndex: {
      type: Number,
      required: true,
    },
    rating: {
      type: Number,
      min: 1,
      max: 5,
      required: true,
    },
    feedback: {
      type: String,
      maxlength: 500,
    },
    category: {
      type: String,
      enum: ["helpful", "accurate", "relevant", "clear", "actionable", "other"],
    },
  },
  {
    timestamps: true,
  },
);

const analyticsSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    eventType: {
      type: String,
      enum: [
        "chat_message",
        "soil_analysis",
        "weather_query",
        "market_query",
        "geocoding",
        "socket_connection",
        "socket_disconnect",
        "socket_error",
      ],
      required: true,
    },
    eventData: {
      type: mongoose.Schema.Types.Mixed,
    },
    sessionId: String,
    userAgent: String,
    ipAddress: String,
    responseTime: Number,
    success: {
      type: Boolean,
      default: true,
    },
    errorMessage: String,
  },
  {
    timestamps: true,
  },
);

analyticsSchema.index({ userId: 1, createdAt: -1 });
analyticsSchema.index({ eventType: 1, createdAt: -1 });

const userPreferencesSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    language: {
      type: String,
      default: "en",
      enum: ["en", "hi", "bn", "te", "ta", "mr", "gu", "kn", "ml", "or"],
    },
    farmingType: {
      type: String,
      enum: ["traditional", "organic", "modern", "mixed"],
      default: "mixed",
    },
    primaryCrops: [String],
    location: {
      state: String,
      district: String,
      village: String,
      coordinates: {
        lat: Number,
        lon: Number,
      },
    },
    farmSize: {
      value: Number,
      unit: {
        type: String,
        enum: ["acres", "hectares", "bigha", "square_feet"],
        default: "acres",
      },
    },
    experienceLevel: {
      type: String,
      enum: ["beginner", "intermediate", "experienced", "expert"],
      default: "intermediate",
    },
    notificationPreferences: {
      weather: { type: Boolean, default: true },
      market: { type: Boolean, default: true },
      farming_tips: { type: Boolean, default: true },
      pest_alerts: { type: Boolean, default: true },
    },
    // Cooldown state for the weather-alert job — colocated here rather than
    // a new collection since it's already per-user, already read/written in
    // the same pass as notificationPreferences/location. Tracked per alert
    // type (not one shared slot) so e.g. an ongoing heavy-rain cooldown
    // can't mask an independently-firing extreme-heat alert.
    lastWeatherAlert: {
      heavyRainAt: { type: Date, default: null },
      extremeHeatAt: { type: Date, default: null },
    },
  },
  {
    timestamps: true,
  },
);

export const Conversation = mongoose.model("Conversation", conversationSchema);
export const Feedback = mongoose.model("Feedback", feedbackSchema);
export const Analytics = mongoose.model("Analytics", analyticsSchema);
export const UserPreferences = mongoose.model(
  "UserPreferences",
  userPreferencesSchema,
);

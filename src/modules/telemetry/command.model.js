import mongoose from "mongoose";
import config from "../../config/env.js";

const commandReasonSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      enum: ["pest_detection", "manual"],
      default: "manual",
    },
    capture: { type: mongoose.Schema.Types.ObjectId, ref: "DeviceCapture" },
    label: { type: String, trim: true },
    confidence: { type: Number },
    pestName: { type: String, trim: true },
    category: { type: String, trim: true },
  },
  { _id: false }
);

const commandResultSchema = new mongoose.Schema(
  {
    executed: { type: Boolean },
    actualRuntimeS: { type: Number },
    error: { type: String, trim: true },
  },
  { _id: false }
);

const actuatorCommandSchema = new mongoose.Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    device: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Device",
      required: true,
      index: true,
    },
    actuator: {
      type: String,
      enum: ["sprinkler"],
      default: "sprinkler",
      required: true,
    },
    action: { type: String, enum: ["on", "off"], default: "on", required: true },
    durationS: { type: Number, min: 1, max: 3600 },

    status: {
      type: String,
      enum: ["pending", "sent", "acked", "expired", "cancelled", "failed"],
      default: "pending",
      index: true,
    },

    reason: { type: commandReasonSchema, default: () => ({}) },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + config.actuatorCommandTtlS * 1000),
    },
    sentAt: { type: Date },
    ackedAt: { type: Date },
    result: { type: commandResultSchema, default: () => ({}) },
  },
  { timestamps: true }
);

actuatorCommandSchema.index(
  { device: 1, status: 1, createdAt: -1 },
  { partialFilterExpression: { status: { $in: ["pending", "sent"] } } }
);

actuatorCommandSchema.index({ device: 1, ackedAt: -1 });

actuatorCommandSchema.index({ owner: 1, createdAt: -1 });

export default mongoose.model("ActuatorCommand", actuatorCommandSchema);

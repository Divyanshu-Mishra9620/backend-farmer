import mongoose from "mongoose";

// What the gateway's on-device model said about this photo (see
// edgePrediction.js). Null for photos from gateways without the model.
const edgePredictionSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true },
    confidence: { type: Number, min: 0, max: 100 },
    top: [
      {
        _id: false,
        label: { type: String, trim: true },
        confidence: { type: Number, min: 0, max: 100 },
      },
    ],
    model: { type: String, trim: true },
    inferenceMs: { type: Number, default: null },
    decodeMs: { type: Number, default: null },
  },
  { _id: false }
);

const deviceCaptureSchema = new mongoose.Schema(
  {
    device: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Device",
      required: true,
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    nodeLabel: { type: String, trim: true },
    imageUrl: { type: String, default: null },
    analysis: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Analysis",
      default: null,
    },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending",
    },
    trigger: {
      type: String,
      enum: ["timer", "motion", "manual", "alert"],
      default: "timer",
    },
    batteryMv: { type: Number, default: null },
    capturedAt: { type: Date },
    error: { type: String, default: null },
    edge: { type: edgePredictionSchema, default: null },
  },
  { timestamps: true }
);

deviceCaptureSchema.index({ owner: 1, createdAt: -1 });

export default mongoose.model("DeviceCapture", deviceCaptureSchema);

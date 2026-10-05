import mongoose from "mongoose";

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
  },
  { timestamps: true }
);

deviceCaptureSchema.index({ owner: 1, createdAt: -1 });

export default mongoose.model("DeviceCapture", deviceCaptureSchema);

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
    // Set once the detached disease pipeline resolves. Kept as a reference
    // rather than a copy of the result so a capture and the same image opened
    // from the disease-detection history stay the one record.
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

// Sorted by createdAt rather than capturedAt: the captures page is a feed of
// what arrived, and a node flushing yesterday's photo after a week offline
// belongs at the top of it.
deviceCaptureSchema.index({ owner: 1, createdAt: -1 });

export default mongoose.model("DeviceCapture", deviceCaptureSchema);

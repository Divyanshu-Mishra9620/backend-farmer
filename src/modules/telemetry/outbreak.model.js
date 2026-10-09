import mongoose from "mongoose";

// One row per person told about a disease found by a field camera.
//
// scope "own_plot":    the camera's owner, about their OTHER plots near it.
// scope "nearby_farm": another farmer whose devices are within the outbreak
//                      radius (or in the same district when GPS is missing).
//
// The source* fields are kept for de-duplication and auditing only. They are
// never sent to a nearby_farm recipient: a neighbour learns the disease, the
// crop and a rounded distance, not who reported it or where exactly.
const outbreakAlertSchema = new mongoose.Schema(
  {
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    scope: {
      type: String,
      enum: ["own_plot", "nearby_farm"],
      required: true,
    },
    // Same disease from the same source inside the cooldown window shares a
    // key, so a camera that keeps seeing it every 30 minutes alerts once.
    dedupeKey: { type: String, required: true },

    sourceOwner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    sourceDevice: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Device",
      required: true,
    },
    sourceCapture: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DeviceCapture",
      default: null,
    },
    analysis: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Analysis",
      default: null,
    },
    sourceNodeLabel: { type: String, trim: true },
    sourcePlot: { type: String, trim: true },

    disease: { type: String, required: true, trim: true },
    diseaseTitle: { type: String, trim: true },
    crop: { type: String, trim: true },
    confidence: { type: Number, min: 0, max: 100 },

    // The recipient's own plots / devices that are close to the source.
    affectedPlots: { type: [String], default: [] },
    // Distance from the source to the recipient's nearest matched device, in
    // km. Null when the match was by district (no GPS on one side).
    distanceKm: { type: Number, default: null },
    matchedBy: {
      type: String,
      enum: ["distance", "district", "same_farm"],
      required: true,
    },
    district: { type: String, trim: true },

    dismissedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

outbreakAlertSchema.index({ recipient: 1, createdAt: -1 });
outbreakAlertSchema.index({ recipient: 1, dedupeKey: 1, createdAt: -1 });
// Old alerts are of no use and should not pile up forever.
outbreakAlertSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 }
);

export default mongoose.model("OutbreakAlert", outbreakAlertSchema);

import mongoose from "mongoose";

const locationSchema = new mongoose.Schema(
  {
    latitude: Number,
    longitude: Number,
    district: { type: String, trim: true },
    state: { type: String, trim: true },
  },
  { _id: false }
);

const deviceConfigSchema = new mongoose.Schema(
  {
    readingIntervalS: { type: Number, default: 300, min: 10 },
    captureIntervalS: { type: Number, default: 1800, min: 60 },
    captureEnabled: { type: Boolean, default: true },
  },
  { _id: false }
);

const thresholdsSchema = new mongoose.Schema(
  {
    soilDryPct: { type: Number, default: 25 },
    soilSaturatedPct: { type: Number, default: 85 },
    heatStressC: { type: Number, default: 38 },
    frostRiskC: { type: Number, default: 4 },
    batteryLowMv: { type: Number, default: 3400 },
  },
  { _id: false }
);

const actuatorConfigSchema = new mongoose.Schema(
  {
    sprinklerEnabled: { type: Boolean, default: false },
    maxRuntimeS: { type: Number, min: 1, max: 3600, default: null },
    cooldownS: { type: Number, min: 0, default: null },
    dailyBudgetS: { type: Number, min: 0, default: null },
  },
  { _id: false }
);

const alertPushSchema = new mongoose.Schema(
  {
    soil_dry: Date,
    soil_saturated: Date,
    heat_stress: Date,
    frost_risk: Date,
    battery_low: Date,
    device_offline: Date,
  },
  { _id: false }
);

const deviceSchema = new mongoose.Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    nodeLabel: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 15,
    },
    type: {
      type: String,
      enum: ["sensor", "camera", "gateway"],
      default: "sensor",
    },
    keyHash: { type: String, required: true, select: false },
    keyPrefix: { type: String },
    plot: { type: String, trim: true },
    crop: { type: String, trim: true },
    location: locationSchema,
    isActive: { type: Boolean, default: true },
    lastSeenAt: { type: Date },
    lastRssi: { type: Number },
    lastBatteryMv: { type: Number },
    firmwareVersion: { type: String, trim: true },
    config: { type: deviceConfigSchema, default: () => ({}) },
    thresholds: { type: thresholdsSchema, default: () => ({}) },
    actuators: { type: actuatorConfigSchema, default: () => ({}) },
    lastAlertPushedAt: { type: alertPushSchema, default: () => ({}) },
  },
  { timestamps: true }
);

deviceSchema.index({ owner: 1, nodeLabel: 1 }, { unique: true });
deviceSchema.index({ keyHash: 1 });

deviceSchema.methods.isOnlineWithin = function (offlineAfterS) {
  if (!this.lastSeenAt) return false;
  return Date.now() - this.lastSeenAt.getTime() < offlineAfterS * 1000;
};

export default mongoose.model("Device", deviceSchema);

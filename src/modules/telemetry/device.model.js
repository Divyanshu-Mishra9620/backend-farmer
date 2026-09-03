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

// Pushed back to the gateway on every ingest response so a config change made
// in the dashboard reaches the field without the firmware polling for it.
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

// Per-device actuator wiring and limits. `enabled` defaults to FALSE: a device
// only accepts spray commands once someone has explicitly said a relay is
// physically wired to it. Registering a gateway must never make it capable of
// opening a valve by default.
//
// The three limits shadow the config.actuator* env defaults so one plot with a
// small drip line can be capped tighter than the site-wide default without
// changing the deployment. Null means "use the env default".
const actuatorConfigSchema = new mongoose.Schema(
  {
    sprinklerEnabled: { type: Boolean, default: false },
    maxRuntimeS: { type: Number, min: 1, max: 3600, default: null },
    cooldownS: { type: Number, min: 0, default: null },
    dailyBudgetS: { type: Number, min: 0, default: null },
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
    // 15, not 16: the radio side carries this in `char nodeLabel[16]` and
    // kn_set_label() always reserves the last byte for the NUL terminator, so
    // a 16-character label would arrive silently truncated.
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
    // The first 12 characters of the plaintext key, kept in the clear. The key
    // itself is unrecoverable after issue, so without this a user staring at
    // four identical "Plot A" rows has no way to tell which physical board is
    // which when one needs replacing.
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
  },
  { timestamps: true }
);

// nodeLabel is what the firmware puts on the air and what a user types when
// relabelling, so it only has to be unique within one account — two farmers
// may both sensibly call a node "plot-a-soil".
deviceSchema.index({ owner: 1, nodeLabel: 1 }, { unique: true });
deviceSchema.index({ keyHash: 1 });

// The staleness window lives in env, not here, so the caller passes it in
// rather than the model reaching into config — this only exists to keep the
// same arithmetic from being written out in listDevices, latestPerDevice and
// summary.
deviceSchema.methods.isOnlineWithin = function (offlineAfterS) {
  if (!this.lastSeenAt) return false;
  return Date.now() - this.lastSeenAt.getTime() < offlineAfterS * 1000;
};

export default mongoose.model("Device", deviceSchema);

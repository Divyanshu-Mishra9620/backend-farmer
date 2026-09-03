import mongoose from "mongoose";
import config from "../../config/env.js";

// Why the detection that motivated a command is stored on the command itself:
// after the fact, "why did the sprinkler run at 14:32" is the only question
// anyone asks, and reconstructing it by joining a capture to an analysis to a
// timestamp window is guesswork. This makes it a lookup.
const commandReasonSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      enum: ["pest_detection", "manual"],
      default: "manual",
    },
    capture: { type: mongoose.Schema.Types.ObjectId, ref: "DeviceCapture" },
    // The raw ML class label plus what the pest policy made of it, copied
    // rather than referenced: the policy artifact is rebuilt when the model is
    // retrained, and a historical command must keep the reasoning that was
    // actually applied at the time, not whatever the current table says.
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
    // What the firmware reports it actually did, which is not necessarily what
    // was asked: a watchdog cut, a manual override at the panel, or a brownout
    // mid-run all show up as a shorter runtime than requested.
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
    // Only one actuator exists today. It is an enum rather than a bare boolean
    // "sprinkler on" flag so a dosing pump or a vent can be added later without
    // reshaping the queue or the firmware's parse path.
    actuator: {
      type: String,
      enum: ["sprinkler"],
      default: "sprinkler",
      required: true,
    },
    action: { type: String, enum: ["on", "off"], default: "on", required: true },
    // Ignored for action "off". Always present for "on" — a relay command with
    // no duration is how a valve gets left open.
    durationS: { type: Number, min: 1, max: 3600 },

    status: {
      type: String,
      enum: ["pending", "sent", "acked", "expired", "cancelled", "failed"],
      default: "pending",
      index: true,
    },

    reason: { type: commandReasonSchema, default: () => ({}) },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    // The core safety property. A command is only delivered while `now` is
    // before this instant; past it the queue expires it instead. See
    // config.actuatorCommandTtlS for why the window is deliberately short.
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

// Serves the delivery path: "the one live command for this device, newest
// first". Partial rather than plain so the index stays small — the collection
// is overwhelmingly terminal-state rows, and only pending/sent are ever queried
// on the hot path that runs on every single ingest request.
actuatorCommandSchema.index(
  { device: 1, status: 1, createdAt: -1 },
  { partialFilterExpression: { status: { $in: ["pending", "sent"] } } }
);

// Powers the cooldown and the daily-budget check, both of which scan recent
// completed commands for one device.
actuatorCommandSchema.index({ device: 1, ackedAt: -1 });

// History list for the dashboard.
actuatorCommandSchema.index({ owner: 1, createdAt: -1 });

export default mongoose.model("ActuatorCommand", actuatorCommandSchema);

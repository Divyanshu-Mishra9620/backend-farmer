import mongoose from "mongoose";
import config from "../../config/env.js";

const telemetryReadingSchema = new mongoose.Schema(
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

    // Every measurement defaults to null and never to 0. The radio protocol
    // sends NAN / KN_BATT_UNKNOWN for a sensor that isn't fitted or failed to
    // read, and a soil probe genuinely reading 0% must not end up looking
    // identical to one that is unplugged — the aggregates in summary() rely on
    // $avg skipping nulls to keep dead sensors out of the averages.
    soilMoisturePct: { type: Number, default: null },
    soilRaw: { type: Number, default: null },
    temperatureC: { type: Number, default: null },
    humidityPct: { type: Number, default: null },
    lux: { type: Number, default: null },
    rainDetected: { type: Boolean, default: null },
    batteryMv: { type: Number, default: null },
    rssi: { type: Number, default: null },
    uptimeS: { type: Number, default: null },

    // When the node says it took the sample (clamped to server time if its
    // clock is implausible) versus when the request actually landed. Charts
    // plot recordedAt; receivedAt is what shows an offline buffer flush.
    recordedAt: { type: Date, required: true },
    receivedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

telemetryReadingSchema.index({ owner: 1, recordedAt: -1 });
telemetryReadingSchema.index({ device: 1, recordedAt: -1 });

// Only declared when retention is actually configured: expireAfterSeconds: 0
// does not mean "no expiry", it means "delete as soon as recordedAt passes",
// so passing a 0 setting straight through would wipe the collection instead of
// disabling the TTL the way the contract says it should.
if (config.telemetryRetentionDays > 0) {
  telemetryReadingSchema.index(
    { recordedAt: 1 },
    { expireAfterSeconds: config.telemetryRetentionDays * 24 * 60 * 60 }
  );
}

export default mongoose.model("TelemetryReading", telemetryReadingSchema);

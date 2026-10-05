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

    soilMoisturePct: { type: Number, default: null },
    soilRaw: { type: Number, default: null },
    temperatureC: { type: Number, default: null },
    humidityPct: { type: Number, default: null },
    lux: { type: Number, default: null },
    rainDetected: { type: Boolean, default: null },
    batteryMv: { type: Number, default: null },
    rssi: { type: Number, default: null },
    uptimeS: { type: Number, default: null },

    recordedAt: { type: Date, required: true },
    receivedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

telemetryReadingSchema.index({ owner: 1, recordedAt: -1 });
telemetryReadingSchema.index({ device: 1, recordedAt: -1 });

if (config.telemetryRetentionDays > 0) {
  telemetryReadingSchema.index(
    { recordedAt: 1 },
    { expireAfterSeconds: config.telemetryRetentionDays * 24 * 60 * 60 }
  );
}

export default mongoose.model("TelemetryReading", telemetryReadingSchema);

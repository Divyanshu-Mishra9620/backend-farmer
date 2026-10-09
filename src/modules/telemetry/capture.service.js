import fs from "fs";
import DeviceCapture from "./capture.model.js";
import Device from "./device.model.js";
import { normalizeNodeLabel, resolveNodeDevices } from "./device.service.js";
import { clampToServerTime } from "./telemetry.service.js";
import { analyzeImage } from "../disease-detection/detection.service.js";
import { raiseOutbreakAlerts } from "./outbreak.service.js";
import { uploadToCloudinary } from "../../shared/utils/cloudinary.js";
import { emitToUser } from "../chat/socket.js";
import config from "../../config/env.js";
import httpError from "../../shared/utils/httpError.js";
import { createLogger } from "../../shared/utils/logger.js";

const logger = createLogger("DeviceCapture");

const serializeCapture = (capture) => ({
  id: capture._id,
  deviceId: capture.device,
  nodeLabel: capture.nodeLabel,
  imageUrl: capture.imageUrl,
  analysisId: capture.analysis,
  status: capture.status,
  trigger: capture.trigger,
  batteryMv: capture.batteryMv,
  capturedAt: capture.capturedAt,
  error: capture.error,
  createdAt: capture.createdAt,
});

function toAnalysisLocation(device) {
  const location = {};
  if (device.location?.district) location.district = device.location.district;
  if (device.location?.state) location.state = device.location.state;
  if (
    typeof device.location?.latitude === "number" &&
    typeof device.location?.longitude === "number"
  ) {
    location.coordinates = {
      latitude: device.location.latitude,
      longitude: device.location.longitude,
    };
  }
  return location;
}

const hasLocation = (device) => Object.keys(toAnalysisLocation(device)).length > 0;

function removeUpload(filePath, what) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    logger.error(`Failed to clean up local file for ${what}`, { error: err.message });
  }
}

async function markFailed(capture, ownerRoom, err) {
  try {
    capture.status = "failed";
    capture.error = err?.message || String(err);
    // The diagnosis can fail after the picture is safely on Cloudinary; keep it
    // so the dashboard still shows what the camera saw.
    if (err?.imageUrl) capture.imageUrl = err.imageUrl;
    await capture.save();

    emitToUser(ownerRoom, "device_capture_analyzed", {
      captureId: capture._id,
      analysisId: null,
      deviceId: capture.device,
      nodeLabel: capture.nodeLabel,
      status: "failed",
      detection: null,
      confidence: null,
      imageUrl: capture.imageUrl,
      at: new Date(),
    });
  } catch (nested) {
    logger.error(`Could not record capture failure for ${capture._id}`, {
      error: nested.message,
    });
  }
}

async function markAnalyzed(capture, ownerRoom, analysis) {
  capture.imageUrl = analysis.imageUrl;
  capture.analysis = analysis._id;
  capture.status = analysis.status === "failed" ? "failed" : "completed";
  capture.error = analysis.status === "failed" ? analysis.error : null;
  await capture.save();

  emitToUser(ownerRoom, "device_capture_analyzed", {
    captureId: capture._id,
    analysisId: analysis._id,
    deviceId: capture.device,
    nodeLabel: capture.nodeLabel,
    status: capture.status,
    detection: analysis.detection || null,
    confidence: analysis.confidencePercentage ?? null,
    mitigation: analysis.mitigation ?? null,
    action: analysis.action ?? null,
    imageUrl: analysis.imageUrl,
    at: new Date(),
  });
}

export const createCapture = async (device, file, meta = {}) => {
  if (!file) {
    throw httpError(400, "Image file is required");
  }

  const analyze = meta.analyze !== false;
  const label = normalizeNodeLabel(meta.nodeLabel);

  // A gateway uploads on behalf of the camera node behind it, tagging the frame
  // with that node's label. File the capture under the camera's own device when
  // it is registered, so it shows on the right tile; otherwise it stays on the
  // authenticated device as before.
  const leaves = await resolveNodeDevices(device, [label]);
  const target = (label && leaves.get(label)) || device;

  if (target.isActive === false) {
    removeUpload(file.path, "rejected capture");
    throw httpError(403, "Device is deactivated");
  }

  const nodeLabel = label || device.nodeLabel;

  const capture = await DeviceCapture.create({
    device: target._id,
    owner: device.owner,
    nodeLabel,
    status: analyze ? "processing" : "pending",
    trigger: meta.trigger || "timer",
    batteryMv: meta.batteryMv ?? null,
    capturedAt: clampToServerTime(meta.capturedAt),
  });

  if (target !== device) {
    const seen = { lastSeenAt: new Date() };
    const battery = Number(meta.batteryMv);
    if (meta.batteryMv != null && meta.batteryMv !== "" && Number.isFinite(battery)) {
      seen.lastBatteryMv = battery;
    }
    try {
      await Device.updateOne({ _id: target._id }, { $set: seen });
    } catch (err) {
      logger.warn(`Could not stamp lastSeenAt on ${target._id}`, { error: err.message });
    }
  }

  const ownerRoom = String(device.owner);

  if (!analyze) {
    if (
      config.cloudinaryApiKey &&
      config.cloudinaryApiSecret &&
      config.cloudinaryCloudName
    ) {
      try {
        capture.imageUrl = await uploadToCloudinary(file.path, {
          folder: "device-captures",
          transformation: [
            { width: 1000, height: 1000, crop: "limit" },
            { quality: "auto" },
          ],
        });
      } catch (err) {
        logger.error(`Cloudinary upload failed for capture ${capture._id}`, {
          error: err.message,
        });
      }
    }

    if (!capture.imageUrl && fs.existsSync(file.path)) {
      try {
        fs.unlinkSync(file.path);
      } catch (cleanupError) {
        logger.error(`Failed to clean up local file for capture ${capture._id}`, {
          error: cleanupError.message,
        });
      }
    }

    capture.status = "completed";
    await capture.save();

    emitToUser(ownerRoom, "device_capture_received", {
      captureId: capture._id,
      deviceId: target._id,
      nodeLabel,
      imageUrl: capture.imageUrl,
      status: capture.status,
      at: new Date(),
    });

    return serializeCapture(capture);
  }

  emitToUser(ownerRoom, "device_capture_received", {
    captureId: capture._id,
    deviceId: target._id,
    nodeLabel,
    imageUrl: null,
    status: "processing",
    at: new Date(),
  });

  analyzeImage({
    filePath: file.path,
    originalName: file.originalname,
    userId: device.owner,
    crop: meta.crop || target.crop || device.crop,
    location: hasLocation(target) ? toAnalysisLocation(target) : toAnalysisLocation(device),
    provider: "groq",
  })
    .then(async (analysis) => {
      await markAnalyzed(capture, ownerRoom, analysis);
      // Fire and forget, and outside the catch below: a problem warning the
      // neighbours must never mark a good diagnosis as failed.
      if (capture.status === "completed") {
        raiseOutbreakAlerts({
          capture,
          analysis,
          sourceDevice: target,
          gateway: device,
        }).catch((err) =>
          logger.error(`Outbreak alerting crashed for capture ${capture._id}`, {
            error: err.message,
          })
        );
      }
    })
    .catch((err) => markFailed(capture, ownerRoom, err));

  return serializeCapture(capture);
};

export const listCaptures = async (ownerId, options = {}) => {
  const query = { owner: ownerId };
  if (options.deviceId) query.device = options.deviceId;
  if (options.status) query.status = options.status;

  const limit = Math.min(Math.max(parseInt(options.limit, 10) || 20, 1), 100);
  const offset = Math.max(parseInt(options.offset, 10) || 0, 0);

  const [captures, total] = await Promise.all([
    DeviceCapture.find(query)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .populate("analysis", "status detection mitigation action recommendations createdAt"),
    DeviceCapture.countDocuments(query),
  ]);

  return {
    captures: captures.map((capture) => ({
      ...serializeCapture(capture),
      analysisId: capture.analysis?._id ?? null,
      analysis: capture.analysis
        ? {
            id: capture.analysis._id,
            status: capture.analysis.status,
            detection: capture.analysis.detection,
            mitigation: capture.analysis.mitigation,
            action: capture.analysis.action,
            recommendations: capture.analysis.recommendations,
            createdAt: capture.analysis.createdAt,
          }
        : null,
    })),
    total,
    limit,
    offset,
    hasMore: offset + limit < total,
  };
};

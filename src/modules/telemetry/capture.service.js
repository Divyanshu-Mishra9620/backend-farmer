import fs from "fs";
import DeviceCapture from "./capture.model.js";
import { clampToServerTime } from "./telemetry.service.js";
import { analyzeImage } from "../disease-detection/detection.service.js";
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

// The Device model stores flat lat/long; analyzeImage expects them nested under
// `coordinates`, so this is the seam between the two shapes.
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

// Never throws. It runs inside a detached promise chain, so anything escaping
// it becomes an unhandled rejection and takes the process down with it.
async function markFailed(capture, ownerRoom, err) {
  try {
    capture.status = "failed";
    capture.error = err?.message || String(err);
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
  // Cloudinary upload happens inside analyzeImage, which then deletes the local
  // file — the returned document is the only place the durable URL exists.
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
    imageUrl: analysis.imageUrl,
    at: new Date(),
  });
}

export const createCapture = async (device, file, meta = {}) => {
  if (!file) {
    throw httpError(400, "Image file is required");
  }

  const analyze = meta.analyze !== false;
  const nodeLabel =
    typeof meta.nodeLabel === "string" && meta.nodeLabel.trim()
      ? meta.nodeLabel.trim().toLowerCase().slice(0, 15)
      : device.nodeLabel;

  const capture = await DeviceCapture.create({
    device: device._id,
    owner: device.owner,
    nodeLabel,
    status: analyze ? "processing" : "pending",
    trigger: meta.trigger || "timer",
    batteryMv: meta.batteryMv ?? null,
    capturedAt: clampToServerTime(meta.capturedAt),
  });

  const ownerRoom = String(device.owner);

  if (!analyze) {
    // Nothing else will move this file: analyzeImage is what normally uploads
    // and unlinks it, so the store-only path has to do both itself or the
    // image is stranded on an ephemeral container disk with no reachable URL.
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

    // Cloudinary owns and unlinks file.path itself on a successful upload, but
    // nothing else does on the other two paths through this branch —
    // Cloudinary unconfigured, or configured and failing — so the multer temp
    // file is removed here whenever imageUrl never ended up pointing at a
    // durable copy. The alternative is an orphaned file per store-only capture
    // for the lifetime of the container disk.
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
      deviceId: device._id,
      nodeLabel,
      imageUrl: capture.imageUrl,
      status: capture.status,
      at: new Date(),
    });

    return serializeCapture(capture);
  }

  emitToUser(ownerRoom, "device_capture_received", {
    captureId: capture._id,
    deviceId: device._id,
    nodeLabel,
    // Still null: the Cloudinary upload is the first step inside analyzeImage,
    // so no durable URL exists yet. device_capture_analyzed carries it.
    imageUrl: null,
    status: "processing",
    at: new Date(),
  });

  // Detached on purpose. The disease pipeline runs for tens of seconds and a
  // battery-powered ESP32 holding a TLS socket open that long is how you get
  // spurious retries and duplicate uploads, so the request returns as soon as
  // the image is durably handed off (API_CONTRACT.md §2).
  //
  // The .catch() is load-bearing, not tidiness: with no rejection handler on a
  // detached promise, Node's default --unhandled-rejections=throw terminates
  // the process, so one unreadable JPEG would take the entire API down.
  //
  // analyzeImage owns the file at file.path — it uploads it to Cloudinary and
  // unlinks it, on both the success and the failure path. Nothing here may
  // read or delete it after this call.
  analyzeImage({
    filePath: file.path,
    originalName: file.originalname,
    userId: device.owner,
    crop: meta.crop || device.crop,
    location: toAnalysisLocation(device),
    provider: "groq",
  })
    .then((analysis) => markAnalyzed(capture, ownerRoom, analysis))
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
      .populate("analysis", "status detection recommendations createdAt"),
    DeviceCapture.countDocuments(query),
  ]);

  return {
    captures: captures.map((capture) => ({
      ...serializeCapture(capture),
      // populate() replaced the id with the document, so the linked analysis
      // is spelled out separately and analysisId stays an id in both shapes.
      analysisId: capture.analysis?._id ?? null,
      analysis: capture.analysis
        ? {
            id: capture.analysis._id,
            status: capture.analysis.status,
            detection: capture.analysis.detection,
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

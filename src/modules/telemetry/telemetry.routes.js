import { Router } from "express";
import { checkSchema, validationResult } from "express-validator";
import * as telemetryController from "./telemetry.controller.js";
import { deviceAuth } from "./deviceAuth.middleware.js";
import { uploadSingle } from "../../shared/utils/upload.js";
import { validateImageContent } from "../../shared/middlewares/validateImageContent.js";
import { authMiddleware } from "../../shared/middlewares/authMiddleware.js";
import {
  deviceLimiter,
  deviceUploadLimiter,
} from "../../shared/middlewares/rateLimiter.js";
import config from "../../config/env.js";

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: errors.array(),
    });
  }
  next();
};

const router = Router();

// Measurement fields are checked for range but never for presence, and the
// per-element contents of a batch are left to the service's coercion: an
// unfitted sensor legitimately sends null, and rejecting a 50-reading offline
// flush because one buffered entry has a garbled float would lose the other 49.
const readingsValidation = {
  readings: {
    in: ["body"],
    optional: true,
    isArray: {
      options: { min: 1, max: config.telemetryMaxBatch },
      errorMessage: `readings must be an array of 1 to ${config.telemetryMaxBatch} entries`,
    },
  },
  nodeLabel: {
    in: ["body"],
    optional: true,
    isString: true,
    isLength: { options: { min: 1, max: 15 } },
    trim: true,
  },
  soilMoisturePct: {
    in: ["body"],
    optional: { options: { nullable: true } },
    isFloat: { options: { min: 0, max: 100 } },
  },
  temperatureC: {
    in: ["body"],
    optional: { options: { nullable: true } },
    isFloat: { options: { min: -50, max: 100 } },
  },
  humidityPct: {
    in: ["body"],
    optional: { options: { nullable: true } },
    isFloat: { options: { min: 0, max: 100 } },
  },
  batteryMv: {
    in: ["body"],
    optional: { options: { nullable: true } },
    isInt: { options: { min: 0, max: 20000 } },
  },
  rssi: {
    in: ["body"],
    optional: { options: { nullable: true } },
    isInt: { options: { min: -120, max: 0 } },
  },
  recordedAt: {
    in: ["body"],
    optional: { options: { nullable: true } },
    isISO8601: true,
  },
};

const captureValidation = {
  nodeLabel: {
    in: ["body"],
    optional: true,
    isString: true,
    isLength: { options: { min: 1, max: 15 } },
    trim: true,
  },
  crop: {
    in: ["body"],
    optional: true,
    isString: true,
    isLength: { options: { min: 1, max: 100 } },
    trim: true,
  },
  trigger: {
    in: ["body"],
    optional: true,
    isIn: {
      options: [["timer", "motion", "manual", "alert"]],
      errorMessage: "Trigger must be one of: timer, motion, manual, alert",
    },
  },
  batteryMv: {
    in: ["body"],
    optional: true,
    isInt: { options: { min: 0, max: 20000 } },
    toInt: true,
  },
  capturedAt: {
    in: ["body"],
    optional: true,
    isISO8601: true,
  },
};

const registerDeviceValidation = {
  name: {
    in: ["body"],
    notEmpty: true,
    isString: true,
    isLength: { options: { min: 1, max: 100 } },
    trim: true,
  },
  // 15 rather than 16 so the label survives kn_protocol.h's char nodeLabel[16]
  // with its NUL terminator intact.
  nodeLabel: {
    in: ["body"],
    notEmpty: true,
    isString: true,
    isLength: {
      options: { min: 1, max: 15 },
      errorMessage: "nodeLabel must be 1 to 15 characters",
    },
    trim: true,
  },
  type: {
    in: ["body"],
    optional: true,
    isIn: {
      options: [["sensor", "camera", "gateway"]],
      errorMessage: "Type must be one of: sensor, camera, gateway",
    },
  },
  plot: {
    in: ["body"],
    optional: true,
    isString: true,
    isLength: { options: { max: 100 } },
    trim: true,
  },
  crop: {
    in: ["body"],
    optional: true,
    isString: true,
    isLength: { options: { max: 100 } },
    trim: true,
  },
  "location.latitude": {
    in: ["body"],
    optional: true,
    isFloat: { options: { min: -90, max: 90 } },
  },
  "location.longitude": {
    in: ["body"],
    optional: true,
    isFloat: { options: { min: -180, max: 180 } },
  },
  "location.district": {
    in: ["body"],
    optional: true,
    isString: true,
    isLength: { options: { max: 100 } },
    trim: true,
  },
  "location.state": {
    in: ["body"],
    optional: true,
    isString: true,
    isLength: { options: { max: 100 } },
    trim: true,
  },
};

const updateDeviceValidation = {
  id: { in: ["params"], isMongoId: true, errorMessage: "Invalid device id" },
  name: {
    in: ["body"],
    optional: true,
    isString: true,
    isLength: { options: { min: 1, max: 100 } },
    trim: true,
  },
  nodeLabel: {
    in: ["body"],
    optional: true,
    isString: true,
    isLength: { options: { min: 1, max: 15 } },
    trim: true,
  },
  type: {
    in: ["body"],
    optional: true,
    isIn: { options: [["sensor", "camera", "gateway"]] },
  },
  plot: { in: ["body"], optional: true, isString: true, trim: true },
  crop: { in: ["body"], optional: true, isString: true, trim: true },
  isActive: { in: ["body"], optional: true, isBoolean: true, toBoolean: true },
  "location.latitude": {
    in: ["body"],
    optional: true,
    isFloat: { options: { min: -90, max: 90 } },
  },
  "location.longitude": {
    in: ["body"],
    optional: true,
    isFloat: { options: { min: -180, max: 180 } },
  },
  "location.district": { in: ["body"], optional: true, isString: true, trim: true },
  "location.state": { in: ["body"], optional: true, isString: true, trim: true },
  // config and thresholds are patchable here even though the contract's PATCH
  // row only lists the descriptive fields — the config push that rides on every
  // ingest response has nothing to carry unless something can change it.
  "config.readingIntervalS": {
    in: ["body"],
    optional: true,
    isInt: { options: { min: 10, max: 86400 } },
    toInt: true,
  },
  "config.captureIntervalS": {
    in: ["body"],
    optional: true,
    isInt: { options: { min: 60, max: 86400 } },
    toInt: true,
  },
  "config.captureEnabled": {
    in: ["body"],
    optional: true,
    isBoolean: true,
    toBoolean: true,
  },
  "thresholds.soilDryPct": {
    in: ["body"],
    optional: true,
    isFloat: { options: { min: 0, max: 100 } },
    toFloat: true,
  },
  "thresholds.soilSaturatedPct": {
    in: ["body"],
    optional: true,
    isFloat: { options: { min: 0, max: 100 } },
    toFloat: true,
  },
  "thresholds.heatStressC": {
    in: ["body"],
    optional: true,
    isFloat: { options: { min: -50, max: 100 } },
    toFloat: true,
  },
  "thresholds.frostRiskC": {
    in: ["body"],
    optional: true,
    isFloat: { options: { min: -50, max: 100 } },
    toFloat: true,
  },
  "thresholds.batteryLowMv": {
    in: ["body"],
    optional: true,
    isInt: { options: { min: 0, max: 20000 } },
    toInt: true,
  },
  // Enabling the sprinkler is a PATCH on the device rather than part of
  // registration on purpose: it asserts that a relay is physically wired to
  // this board, which is not something a registration form can know.
  "actuators.sprinklerEnabled": {
    in: ["body"],
    optional: true,
    isBoolean: true,
    toBoolean: true,
  },
  "actuators.maxRuntimeS": {
    in: ["body"],
    optional: true,
    isInt: { options: { min: 1, max: 3600 } },
    toInt: true,
  },
  "actuators.cooldownS": {
    in: ["body"],
    optional: true,
    isInt: { options: { min: 0, max: 86400 } },
    toInt: true,
  },
  "actuators.dailyBudgetS": {
    in: ["body"],
    optional: true,
    isInt: { options: { min: 0, max: 86400 } },
    toInt: true,
  },
};

const sprayValidation = {
  id: { in: ["params"], isMongoId: true, errorMessage: "Invalid device id" },
  // Optional: absent means "the maximum this device allows". Clamped rather
  // than rejected when it exceeds the cap — see command.service.js.
  durationS: {
    in: ["body"],
    optional: true,
    isInt: { options: { min: 1, max: 3600 } },
    toInt: true,
  },
  source: {
    in: ["body"],
    optional: true,
    isIn: { options: [["pest_detection", "manual"]] },
  },
  captureId: { in: ["body"], optional: true, isMongoId: true },
  label: { in: ["body"], optional: true, isString: true, trim: true },
  confidence: {
    in: ["body"],
    optional: true,
    isFloat: { options: { min: 0, max: 100 } },
    toFloat: true,
  },
  pestName: { in: ["body"], optional: true, isString: true, trim: true },
  category: { in: ["body"], optional: true, isString: true, trim: true },
};

const commandAckValidation = {
  id: { in: ["params"], isMongoId: true, errorMessage: "Invalid command id" },
  executed: { in: ["body"], optional: true, isBoolean: true, toBoolean: true },
  actualRuntimeS: {
    in: ["body"],
    optional: true,
    isInt: { options: { min: 0, max: 86400 } },
    toInt: true,
  },
  error: {
    in: ["body"],
    optional: true,
    isString: true,
    isLength: { options: { max: 300 } },
    trim: true,
  },
};

const listCommandsValidation = {
  deviceId: { in: ["query"], optional: true, isMongoId: true },
  limit: {
    in: ["query"],
    optional: true,
    isInt: { options: { min: 1, max: 200 } },
    toInt: true,
  },
};

const commandIdValidation = {
  id: { in: ["params"], isMongoId: true, errorMessage: "Invalid command id" },
};

const deviceIdValidation = {
  id: { in: ["params"], isMongoId: true, errorMessage: "Invalid device id" },
};

const listReadingsValidation = {
  deviceId: { in: ["query"], optional: true, isMongoId: true },
  limit: {
    in: ["query"],
    optional: true,
    isInt: { options: { min: 1, max: 200 } },
    toInt: true,
  },
  since: { in: ["query"], optional: true, isISO8601: true, toDate: true },
  until: { in: ["query"], optional: true, isISO8601: true, toDate: true },
};

const listCapturesValidation = {
  deviceId: { in: ["query"], optional: true, isMongoId: true },
  status: {
    in: ["query"],
    optional: true,
    isIn: {
      options: [["pending", "processing", "completed", "failed"]],
      errorMessage:
        "Status must be one of: pending, processing, completed, failed",
    },
  },
  limit: {
    in: ["query"],
    optional: true,
    isInt: { options: { min: 1, max: 100 } },
    toInt: true,
  },
  offset: {
    in: ["query"],
    optional: true,
    isInt: { options: { min: 0 } },
    toInt: true,
  },
};

// Device-facing (X-Device-Key). deviceAuth deliberately runs BEFORE the
// limiter: the limiter keys on req.device, which does not exist until auth has
// resolved the key, so the conventional limiter-first ordering would key every
// node in a field onto their shared NAT address. Unauthenticated floods are
// still covered by the IP-keyed generalLimiter mounted on /api.
router.post(
  "/readings",
  deviceAuth,
  deviceLimiter,
  checkSchema(readingsValidation),
  validate,
  telemetryController.ingestReadings
);

// uploadSingle before validateImageContent, always: multer is what puts the
// file on disk, and validateImageContent sniffs magic bytes off that path.
router.post(
  "/captures",
  deviceAuth,
  deviceUploadLimiter,
  uploadSingle,
  validateImageContent,
  checkSchema(captureValidation),
  validate,
  telemetryController.createCapture
);

router.get("/config", deviceAuth, deviceLimiter, telemetryController.getDeviceConfig);

// The gateway reporting what the relay actually did. Device-authenticated, and
// the command is matched on {id, device} in the service so one device's key can
// never close out another device's command.
router.post(
  "/commands/:id/ack",
  deviceAuth,
  deviceLimiter,
  checkSchema(commandAckValidation),
  validate,
  telemetryController.acknowledgeCommand
);

// User-facing (Bearer JWT).
router.post(
  "/devices",
  authMiddleware,
  checkSchema(registerDeviceValidation),
  validate,
  telemetryController.registerDevice
);
router.get("/devices", authMiddleware, telemetryController.listDevices);
router.patch(
  "/devices/:id",
  authMiddleware,
  checkSchema(updateDeviceValidation),
  validate,
  telemetryController.updateDevice
);
router.post(
  "/devices/:id/rotate-key",
  authMiddleware,
  checkSchema(deviceIdValidation),
  validate,
  telemetryController.rotateDeviceKey
);
router.delete(
  "/devices/:id",
  authMiddleware,
  checkSchema(deviceIdValidation),
  validate,
  telemetryController.deleteDevice
);

// Declared before the bare /readings handler would ever see it — there is no
// /readings/:id route today, but adding one later without this ordering would
// swallow "latest" as an id.
router.get(
  "/readings/latest",
  authMiddleware,
  telemetryController.listLatestReadings
);
router.get(
  "/readings",
  authMiddleware,
  checkSchema(listReadingsValidation),
  validate,
  telemetryController.listReadings
);
router.get(
  "/captures",
  authMiddleware,
  checkSchema(listCapturesValidation),
  validate,
  telemetryController.listCaptures
);
router.get("/summary", authMiddleware, telemetryController.getSummary);

// --- Actuator control (Bearer JWT) -----------------------------------------
// Nothing here actuates anything directly: each of these queues a command that
// the gateway collects on its next report. The farmer pressing "Spray" is the
// required human step between a pest detection and water leaving a nozzle —
// the RAG pipeline only ever recommends.
router.post(
  "/devices/:id/spray",
  authMiddleware,
  checkSchema(sprayValidation),
  validate,
  telemetryController.sprayNow
);
router.post(
  "/devices/:id/spray/stop",
  authMiddleware,
  checkSchema(deviceIdValidation),
  validate,
  telemetryController.stopSpray
);
router.get(
  "/devices/:id/actuator",
  authMiddleware,
  checkSchema(deviceIdValidation),
  validate,
  telemetryController.getActuatorStatus
);
router.get(
  "/commands",
  authMiddleware,
  checkSchema(listCommandsValidation),
  validate,
  telemetryController.listCommands
);
router.post(
  "/commands/:id/cancel",
  authMiddleware,
  checkSchema(commandIdValidation),
  validate,
  telemetryController.cancelCommand
);

export default router;

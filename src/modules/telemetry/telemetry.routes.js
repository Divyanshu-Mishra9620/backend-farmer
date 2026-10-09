import { Router } from "express";
import { checkSchema, validationResult } from "express-validator";
import * as telemetryController from "./telemetry.controller.js";
import { deviceAuth } from "./deviceAuth.middleware.js";
import { uploadSingle } from "../../shared/utils/upload.js";
import { validateImageContent } from "../../shared/middlewares/validateImageContent.js";
import { authMiddleware } from "../../shared/middlewares/authMiddleware.js";
import {
  deviceAuthFailLimiter,
  deviceLimiter,
  deviceUploadLimiter,
} from "../../shared/middlewares/rateLimiter.js";
import config from "../../config/env.js";

// 400 body: the contract shape ({success:false, error:{code,message}}) that the
// firmware and the frontend error handler expect, with the older top-level
// `message` and `errors[]` kept alongside so existing clients keep working.
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const list = errors.array();
    const detail = list
      .map((e) => (e.path ? `${e.path}: ${e.msg}` : String(e.msg)))
      .join("; ");
    return res.status(400).json({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: detail || "Validation failed",
      },
      message: "Validation failed",
      errors: list,
    });
  }
  next();
};

const router = Router();

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

// The firmware sends JSON null for anything it did not measure (an ack for a
// refused or never-started spray has no runtime), so every optional field here
// accepts null as well as absence.
const commandAckValidation = {
  id: { in: ["params"], isMongoId: true, errorMessage: "Invalid command id" },
  executed: {
    in: ["body"],
    optional: { options: { nullable: true } },
    isBoolean: true,
    toBoolean: true,
  },
  actualRuntimeS: {
    in: ["body"],
    optional: { options: { nullable: true } },
    isInt: { options: { min: 0, max: 86400 } },
    toInt: true,
  },
  // No length cap: the service truncates to 300 chars. A device reporting a long
  // error string should still get its ack recorded, not a permanent 400 that
  // leaves the command re-delivered.
  error: {
    in: ["body"],
    optional: { options: { nullable: true } },
    isString: true,
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

const listOutbreaksValidation = {
  limit: {
    in: ["query"],
    optional: true,
    isInt: { options: { min: 1, max: 50 } },
    toInt: true,
  },
};

const outbreakIdValidation = {
  id: { in: ["params"], isMongoId: true, errorMessage: "Invalid alert id" },
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

router.post(
  "/readings",
  deviceAuthFailLimiter,
  deviceAuth,
  deviceLimiter,
  checkSchema(readingsValidation),
  validate,
  telemetryController.ingestReadings
);

router.post(
  "/captures",
  deviceAuthFailLimiter,
  deviceAuth,
  deviceUploadLimiter,
  uploadSingle,
  validateImageContent,
  checkSchema(captureValidation),
  validate,
  telemetryController.createCapture
);

router.get(
  "/config",
  deviceAuthFailLimiter,
  deviceAuth,
  deviceLimiter,
  telemetryController.getDeviceConfig
);

router.post(
  "/commands/:id/ack",
  deviceAuthFailLimiter,
  deviceAuth,
  deviceLimiter,
  checkSchema(commandAckValidation),
  validate,
  telemetryController.acknowledgeCommand
);

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

router.get(
  "/outbreaks",
  authMiddleware,
  checkSchema(listOutbreaksValidation),
  validate,
  telemetryController.listOutbreaks
);
router.post(
  "/outbreaks/:id/dismiss",
  authMiddleware,
  checkSchema(outbreakIdValidation),
  validate,
  telemetryController.dismissOutbreak
);

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

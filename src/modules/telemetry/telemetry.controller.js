import * as telemetryService from "./telemetry.service.js";
import * as deviceService from "./device.service.js";
import * as captureService from "./capture.service.js";
import * as commandService from "./command.service.js";
import httpError from "../../shared/utils/httpError.js";

export const ingestReadings = async (req, res, next) => {
  try {
    const body = req.body || {};

    const readings = Array.isArray(body.readings) ? body.readings : [body];

    const result = await telemetryService.ingestReadings(req.device, readings);

    const commands = await commandService.claimCommandsForDevice(req.device);

    return res.status(201).json({
      success: true,
      data: {
        accepted: result.accepted,
        rejected: result.rejected,
        deviceId: req.device._id,
        serverTime: new Date().toISOString(),
        config: deviceService.serializeDeviceConfig(req.device),
        commands,
      },
    });
  } catch (err) {
    next(err);
  }
};

export const createCapture = async (req, res, next) => {
  try {
    if (!req.file) {
      throw httpError(400, "Image file is required");
    }

    const capture = await captureService.createCapture(req.device, req.file, {
      nodeLabel: req.body.nodeLabel,
      crop: req.body.crop,
      trigger: req.body.trigger,
      batteryMv: req.body.batteryMv,
      capturedAt: req.body.capturedAt,
      analyze: req.body.analyze !== "false" && req.body.analyze !== false,
    });

    return res.status(202).json({
      success: true,
      data: {
        captureId: capture.id,
        analysisId: capture.analysisId,
        deviceId: req.device._id,
        status: capture.status,
        imageUrl: capture.imageUrl,
      },
    });
  } catch (err) {
    next(err);
  }
};

export const getDeviceConfig = async (req, res, next) => {
  try {
    const commands = await commandService.claimCommandsForDevice(req.device);

    return res.json({
      success: true,
      data: {
        deviceId: req.device._id,
        serverTime: new Date().toISOString(),
        config: deviceService.serializeDeviceConfig(req.device),
        commands,
      },
    });
  } catch (err) {
    next(err);
  }
};

export const acknowledgeCommand = async (req, res, next) => {
  try {
    const result = await commandService.acknowledgeCommand(
      req.device,
      req.params.id,
      {
        executed: req.body?.executed,
        actualRuntimeS: req.body?.actualRuntimeS,
        error: req.body?.error,
      }
    );
    return res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

export const sprayNow = async (req, res, next) => {
  try {
    const result = await commandService.queueSprayCommand(
      req.user.id,
      req.params.id,
      {
        durationS: req.body?.durationS,
        source: req.body?.source,
        captureId: req.body?.captureId,
        label: req.body?.label,
        confidence: req.body?.confidence,
        pestName: req.body?.pestName,
        category: req.body?.category,
      }
    );
    return res.status(202).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

export const stopSpray = async (req, res, next) => {
  try {
    const result = await commandService.queueStopCommand(req.user.id, req.params.id);
    return res.status(202).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

export const getActuatorStatus = async (req, res, next) => {
  try {
    const data = await commandService.actuatorStatus(req.user.id, req.params.id);
    return res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const listCommands = async (req, res, next) => {
  try {
    const result = await commandService.listCommands(req.user.id, {
      deviceId: req.query.deviceId,
      limit: req.query.limit,
    });
    return res.json({
      success: true,
      data: result.commands,
      count: result.commands.length,
      limit: result.limit,
    });
  } catch (err) {
    next(err);
  }
};

export const cancelCommand = async (req, res, next) => {
  try {
    const result = await commandService.cancelCommand(req.user.id, req.params.id);
    return res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

export const registerDevice = async (req, res, next) => {
  try {
    const result = await deviceService.registerDevice(req.user.id, req.body);
    return res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

export const listDevices = async (req, res, next) => {
  try {
    const devices = await deviceService.listDevices(req.user.id);
    return res.json({ success: true, data: devices });
  } catch (err) {
    next(err);
  }
};

export const updateDevice = async (req, res, next) => {
  try {
    const device = await deviceService.updateDevice(
      req.user.id,
      req.params.id,
      req.body
    );
    return res.json({ success: true, data: device });
  } catch (err) {
    next(err);
  }
};

export const rotateDeviceKey = async (req, res, next) => {
  try {
    const result = await deviceService.rotateKey(req.user.id, req.params.id);
    return res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

export const deleteDevice = async (req, res, next) => {
  try {
    const result = await deviceService.deleteDevice(req.user.id, req.params.id);
    return res.json({ success: true, message: result.message });
  } catch (err) {
    next(err);
  }
};

export const listReadings = async (req, res, next) => {
  try {
    const result = await telemetryService.listReadings(req.user.id, {
      deviceId: req.query.deviceId,
      limit: req.query.limit,
      since: req.query.since,
      until: req.query.until,
    });

    return res.json({
      success: true,
      data: result.readings,
      count: result.readings.length,
      limit: result.limit,
    });
  } catch (err) {
    next(err);
  }
};

export const listLatestReadings = async (req, res, next) => {
  try {
    const latest = await telemetryService.latestPerDevice(req.user.id);
    return res.json({ success: true, data: latest });
  } catch (err) {
    next(err);
  }
};

export const listCaptures = async (req, res, next) => {
  try {
    const result = await captureService.listCaptures(req.user.id, {
      deviceId: req.query.deviceId,
      status: req.query.status,
      limit: req.query.limit,
      offset: req.query.offset,
    });

    return res.json({
      success: true,
      data: result.captures,
      pagination: {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        hasMore: result.hasMore,
      },
    });
  } catch (err) {
    next(err);
  }
};

export const getSummary = async (req, res, next) => {
  try {
    const data = await telemetryService.summary(req.user.id);
    return res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

import ActuatorCommand from "./command.model.js";
import Device from "./device.model.js";
import TelemetryReading from "./telemetry.model.js";
import config from "../../config/env.js";
import httpError from "../../shared/utils/httpError.js";
import { emitToUser } from "../chat/socket.js";

const LIVE_STATUSES = ["pending", "sent"];

const limitFor = (device, key, fallback) => {
  const v = device.actuators?.[key];
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

export const serializeCommand = (cmd) => ({
  id: cmd._id,
  deviceId: cmd.device?._id || cmd.device,
  actuator: cmd.actuator,
  action: cmd.action,
  durationS: cmd.durationS,
  status: cmd.status,
  reason: cmd.reason,
  expiresAt: cmd.expiresAt,
  sentAt: cmd.sentAt,
  ackedAt: cmd.ackedAt,
  result: cmd.result,
  createdAt: cmd.createdAt,
});

export const serializeCommandForDevice = (cmd, now = Date.now()) => ({
  id: String(cmd._id),
  actuator: cmd.actuator,
  action: cmd.action,
  durationS: cmd.durationS,
  remainingS: Math.max(0, Math.round((cmd.expiresAt.getTime() - now) / 1000)),
});

async function findOwnedDevice(ownerId, deviceId) {
  const device = await Device.findOne({ _id: deviceId, owner: ownerId });
  if (!device) throw httpError(404, "Device not found");
  return device;
}

async function usedRuntimeS(deviceId) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await ActuatorCommand.find({
    device: deviceId,
    action: "on",
    status: { $in: ["sent", "acked"] },
    createdAt: { $gte: since },
  }).select("durationS result status");

  return rows.reduce((total, r) => {
    const actual = r.result?.actualRuntimeS;
    return total + (Number.isFinite(actual) ? actual : r.durationS || 0);
  }, 0);
}

async function environmentalVeto(device) {
  const plotFilter = device.plot
    ? { plot: device.plot }
    : { plot: { $in: [null, ""] } };

  const plotDevices = await Device.find({
    owner: device.owner,
    ...plotFilter,
  }).select("_id");

  const latest = await TelemetryReading.findOne({
    owner: device.owner,
    device: { $in: plotDevices.map((d) => d._id) },
  })
    .sort({ recordedAt: -1 })
    .select("soilMoisturePct rainDetected recordedAt");

  if (!latest) return null;

  const ageS = (Date.now() - new Date(latest.recordedAt).getTime()) / 1000;
  if (ageS > config.deviceOfflineAfterS) return null;

  if (latest.rainDetected === true) {
    return "It is raining at the plot — the crop is already being washed, so the sprinkler is not needed.";
  }

  const saturated = device.thresholds?.soilSaturatedPct;
  if (
    Number.isFinite(saturated) &&
    Number.isFinite(latest.soilMoisturePct) &&
    latest.soilMoisturePct >= saturated
  ) {
    return `Soil moisture is ${latest.soilMoisturePct.toFixed(
      1
    )}%, at or above the ${saturated}% saturation threshold — adding water risks waterlogging the root zone.`;
  }
  return null;
}

export const queueSprayCommand = async (ownerId, deviceId, payload = {}) => {
  const device = await findOwnedDevice(ownerId, deviceId);

  if (!device.isActive) {
    throw httpError(403, "This device is marked inactive");
  }
  if (!device.actuators?.sprinklerEnabled) {
    throw httpError(
      409,
      "No sprinkler is enabled on this device. Wire the relay, then enable it with PATCH /devices/:id { actuators: { sprinklerEnabled: true } }."
    );
  }

  const maxRuntimeS = limitFor(device, "maxRuntimeS", config.actuatorMaxRuntimeS);
  const cooldownS = limitFor(device, "cooldownS", config.actuatorCooldownS);
  const dailyBudgetS = limitFor(device, "dailyBudgetS", config.actuatorDailyBudgetS);

  const requestedS = Number(payload.durationS) || maxRuntimeS;
  if (requestedS < 1) {
    throw httpError(400, "durationS must be at least 1 second");
  }
  const durationS = Math.min(requestedS, maxRuntimeS);

  const inFlight = await ActuatorCommand.findOne({
    device: device._id,
    status: { $in: LIVE_STATUSES },
    expiresAt: { $gt: new Date() },
  });
  if (inFlight) {
    throw httpError(
      409,
      "A sprinkler command is already in flight for this device. Wait for it to complete or cancel it first."
    );
  }

  const lastRun = await ActuatorCommand.findOne({
    device: device._id,
    action: "on",
    status: "acked",
    "result.executed": true,
  }).sort({ ackedAt: -1 });

  if (lastRun?.ackedAt) {
    const sinceS = (Date.now() - new Date(lastRun.ackedAt).getTime()) / 1000;
    if (sinceS < cooldownS) {
      const waitS = Math.ceil(cooldownS - sinceS);
      throw httpError(
        429,
        `The sprinkler ran ${Math.round(
          sinceS / 60
        )} min ago. It is on a ${Math.round(
          cooldownS / 60
        )} min cooldown — try again in ${Math.ceil(waitS / 60)} min.`
      );
    }
  }

  const used = await usedRuntimeS(device._id);
  if (used + durationS > dailyBudgetS) {
    throw httpError(
      429,
      `This would exceed the daily sprinkler budget (${used}s of ${dailyBudgetS}s already used in the last 24 h).`
    );
  }

  const veto = await environmentalVeto(device);
  if (veto) throw httpError(409, veto);

  const command = await ActuatorCommand.create({
    owner: ownerId,
    device: device._id,
    actuator: "sprinkler",
    action: "on",
    durationS,
    issuedBy: ownerId,
    reason: {
      source: payload.source === "pest_detection" ? "pest_detection" : "manual",
      capture: payload.captureId || undefined,
      label: payload.label,
      confidence: payload.confidence,
      pestName: payload.pestName,
      category: payload.category,
    },
    expiresAt: new Date(Date.now() + config.actuatorCommandTtlS * 1000),
  });

  emitToUser(String(ownerId), "actuator_command_queued", {
    commandId: command._id,
    deviceId: device._id,
    nodeLabel: device.nodeLabel,
    actuator: command.actuator,
    action: command.action,
    durationS: command.durationS,
    expiresAt: command.expiresAt,
    reason: command.reason,
    at: new Date().toISOString(),
  });

  return {
    command: serializeCommand(command),
    requestedDurationS: requestedS,
    grantedDurationS: durationS,
    clamped: durationS < requestedS,
  };
};

export const queueStopCommand = async (ownerId, deviceId) => {
  const device = await findOwnedDevice(ownerId, deviceId);

  await ActuatorCommand.updateMany(
    { device: device._id, status: { $in: LIVE_STATUSES } },
    { $set: { status: "cancelled" } }
  );

  const command = await ActuatorCommand.create({
    owner: ownerId,
    device: device._id,
    actuator: "sprinkler",
    action: "off",
    issuedBy: ownerId,
    reason: { source: "manual" },
    expiresAt: new Date(Date.now() + config.actuatorCommandTtlS * 1000),
  });

  emitToUser(String(ownerId), "actuator_command_queued", {
    commandId: command._id,
    deviceId: device._id,
    nodeLabel: device.nodeLabel,
    actuator: command.actuator,
    action: "off",
    at: new Date().toISOString(),
  });

  return { command: serializeCommand(command) };
};

export const cancelCommand = async (ownerId, commandId) => {
  const command = await ActuatorCommand.findOne({ _id: commandId, owner: ownerId });
  if (!command) throw httpError(404, "Command not found");
  if (!LIVE_STATUSES.includes(command.status)) {
    throw httpError(409, `Command is already ${command.status}`);
  }
  command.status = "cancelled";
  await command.save();
  return { command: serializeCommand(command) };
};

export const claimCommandsForDevice = async (device) => {
  const now = new Date();

  await ActuatorCommand.updateMany(
    { device: device._id, status: { $in: LIVE_STATUSES }, expiresAt: { $lte: now } },
    { $set: { status: "expired" } }
  );

  const live = await ActuatorCommand.find({
    device: device._id,
    status: { $in: LIVE_STATUSES },
    expiresAt: { $gt: now },
  })
    .sort({ createdAt: 1 })
    .limit(4);

  if (live.length === 0) return [];

  const ids = live.filter((c) => c.status === "pending").map((c) => c._id);
  if (ids.length > 0) {
    await ActuatorCommand.updateMany(
      { _id: { $in: ids } },
      { $set: { status: "sent", sentAt: now } }
    );
  }

  return live.map((c) => serializeCommandForDevice(c, now.getTime()));
};

export const acknowledgeCommand = async (device, commandId, payload = {}) => {
  const command = await ActuatorCommand.findOne({
    _id: commandId,
    device: device._id,
  });
  if (!command) throw httpError(404, "Command not found for this device");

  const wasTerminal = !LIVE_STATUSES.includes(command.status);

  const executed = payload.executed !== false;

  // null / "" mean "the device did not measure it". Number(null) is 0, which
  // would be recorded as a zero-second run and refund that spray's share of the
  // 24h runtime budget in usedRuntimeS(), so only a real number counts.
  const reported = payload.actualRuntimeS;
  const hasRuntime =
    reported !== null &&
    reported !== undefined &&
    reported !== "" &&
    Number.isFinite(Number(reported)) &&
    Number(reported) >= 0;

  command.status = executed ? "acked" : "failed";
  command.ackedAt = new Date();
  command.result = {
    executed,
    actualRuntimeS: hasRuntime ? Number(reported) : undefined,
    error: payload.error ? String(payload.error).slice(0, 300) : undefined,
  };
  await command.save();

  emitToUser(String(command.owner), "actuator_command_result", {
    commandId: command._id,
    deviceId: device._id,
    nodeLabel: device.nodeLabel,
    actuator: command.actuator,
    action: command.action,
    status: command.status,
    executed,
    actualRuntimeS: command.result.actualRuntimeS,
    error: command.result.error,
    lateAck: wasTerminal,
    at: command.ackedAt.toISOString(),
  });

  return { command: serializeCommand(command), lateAck: wasTerminal };
};

export const listCommands = async (ownerId, { deviceId, limit = 50 } = {}) => {
  const query = { owner: ownerId };
  if (deviceId) query.device = deviceId;

  const capped = Math.min(Number(limit) || 50, 200);
  const commands = await ActuatorCommand.find(query)
    .sort({ createdAt: -1 })
    .limit(capped);

  return { commands: commands.map(serializeCommand), limit: capped };
};

export const actuatorStatus = async (ownerId, deviceId) => {
  const device = await findOwnedDevice(ownerId, deviceId);
  const now = new Date();

  const live = await ActuatorCommand.findOne({
    device: device._id,
    status: { $in: LIVE_STATUSES },
    expiresAt: { $gt: now },
  }).sort({ createdAt: -1 });

  const lastRun = await ActuatorCommand.findOne({
    device: device._id,
    action: "on",
    status: "acked",
    "result.executed": true,
  }).sort({ ackedAt: -1 });

  const cooldownS = limitFor(device, "cooldownS", config.actuatorCooldownS);
  const dailyBudgetS = limitFor(device, "dailyBudgetS", config.actuatorDailyBudgetS);
  const used = await usedRuntimeS(device._id);

  let cooldownRemainingS = 0;
  if (lastRun?.ackedAt) {
    const sinceS = (Date.now() - new Date(lastRun.ackedAt).getTime()) / 1000;
    cooldownRemainingS = Math.max(0, Math.ceil(cooldownS - sinceS));
  }

  return {
    deviceId: device._id,
    nodeLabel: device.nodeLabel,
    sprinklerEnabled: Boolean(device.actuators?.sprinklerEnabled),
    online: device.isOnlineWithin(config.deviceOfflineAfterS),
    busy: Boolean(live),
    inFlight: live ? serializeCommand(live) : null,
    lastRunAt: lastRun?.ackedAt || null,
    cooldownS,
    cooldownRemainingS,
    dailyBudgetS,
    dailyUsedS: used,
    maxRuntimeS: limitFor(device, "maxRuntimeS", config.actuatorMaxRuntimeS),
  };
};

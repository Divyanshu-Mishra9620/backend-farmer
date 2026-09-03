/**
 * Actuator command queue.
 *
 * The field rig is otherwise a one-way pipe: leaf nodes push to the gateway,
 * the gateway pushes to us. Nothing has ever travelled the other way except the
 * small `config` object that rides on every ingest response. This module adds
 * the return path for actuator commands, and it deliberately reuses that same
 * piggyback rather than opening a socket or a poll loop to the gateway — a
 * command surfaces on the device's next scheduled report, which is a bounded
 * and already-rate-limited moment.
 *
 * Everything here is built around one assumption: a physical valve is on the
 * other end, and the worst outcome is not "the spray was late" but "the spray
 * happened when nobody expected it" or "the valve never closed". Hence:
 *
 *   - commands EXPIRE (config.actuatorCommandTtlS). A gateway that is offline
 *     when a command is queued and reconnects an hour later gets nothing. The
 *     farmer's intent was about conditions that no longer hold.
 *   - only ONE command is live per device at a time; queueing a second while
 *     one is in flight is a 409, not a second valve operation.
 *   - runtime is clamped, a cooldown gap is enforced, and a rolling 24 h budget
 *     caps the total. All three are checked here AND the runtime cap is checked
 *     again by a watchdog in firmware, because a server-side-only limit is one
 *     dropped ACK away from a valve that stays open.
 *   - a saturated or rained-on plot vetoes the spray outright.
 *
 * The pest policy in the RAG service decides whether spraying is *agronomically*
 * sensible; this module decides whether it is *safe right now*. Both have to
 * agree, and a human has to press the button in between.
 */

import ActuatorCommand from "./command.model.js";
import Device from "./device.model.js";
import TelemetryReading from "./telemetry.model.js";
import config from "../../config/env.js";
import httpError from "../../shared/utils/httpError.js";
import { emitToUser } from "../chat/socket.js";

const LIVE_STATUSES = ["pending", "sent"];

// Per-device override wins over the site default; null/undefined (the schema
// default) means "use the env value". Numbers only — a misconfigured string
// would silently disable a limit, so anything non-finite falls back rather than
// propagating.
//
// Zero is a real value here, not an absent one: cooldownS 0 means "no cooldown"
// and dailyBudgetS 0 means "allow no water at all", which is how a relay stays
// wired but administratively disabled. The schema enforces min 1 on
// maxRuntimeS, so a zero-length run cannot be configured by this route.
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

// What the gateway sees. Deliberately minimal and flat: this is parsed by
// ArduinoJson on a device that is simultaneously holding a TLS session, so
// every field it does not need is heap it should not have to allocate.
// `remainingS` rather than an absolute expiry because the leaf-side clock is
// not trustworthy — see the NTP note in hardware/README.md.
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

/**
 * Sum of relay-on seconds over the trailing 24 h for one device.
 *
 * Counts what the firmware REPORTED it ran (result.actualRuntimeS), falling
 * back to what was requested for a command that was delivered but never acked.
 * Counting the request rather than the report would let a run that was cut
 * short by the watchdog eat budget it never used; ignoring un-acked commands
 * would let a gateway that never acks spray indefinitely. Both directions are
 * wrong, so it takes the reported value when there is one and assumes the worst
 * when there is not.
 */
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

/**
 * Environmental veto. Refuses to add water to ground that already has enough,
 * using the same soilSaturatedPct the soil_saturated alert uses so the dashboard
 * and the actuator cannot disagree about what "saturated" means.
 *
 * A device with no soil reading at all does NOT block the spray — a camera-only
 * gateway legitimately has no probe, and failing closed there would make the
 * feature unusable on exactly the rig it was built for. Absent data is absent,
 * not wet.
 */
async function environmentalVeto(device) {
  // The relay is on the gateway, but the soil probe and rain sensor are on a
  // different board — a leaf sensor node — so the reading that describes this
  // plot belongs to a different Device document. Readings are therefore matched
  // by PLOT, symmetrically: a device in "Plot A" reads Plot A's sensors, and a
  // device with no plot set reads only other unlabelled devices.
  //
  // The symmetry is the point. Falling back to owner-wide for an unlabelled
  // device looks harmless on a one-plot rig and is wrong the moment a second
  // plot exists — rain over the far plot would veto a spray here, and the
  // farmer would get a refusal citing weather they cannot see.
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

  // Stale readings say nothing about now. Past the offline window the plot's
  // condition is unknown, and unknown must not veto (same reasoning as above).
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

/**
 * Queue a spray. Every interlock is checked here, in order of how cheap it is
 * to evaluate and how clearly it is a hard "no".
 */
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
  // Clamped rather than rejected: a farmer asking for 5 minutes on a 2-minute
  // cap wants the longest legal spray, not an error dialog. The response says
  // what was actually granted.
  const durationS = Math.min(requestedS, maxRuntimeS);

  // One live command per device. Checked before the expensive queries because
  // it is the common concurrent-tap case.
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
    // Surfaced so the UI can say "granted 120s of the 300s you asked for"
    // instead of silently doing something different from what was tapped.
    requestedDurationS: requestedS,
    grantedDurationS: durationS,
    clamped: durationS < requestedS,
  };
};

/**
 * An immediate stop. Deliberately bypasses every interlock above — cooldown,
 * budget and saturation are reasons not to START water, never reasons to refuse
 * to stop it. It also does not care whether a command is currently in flight,
 * because the case that matters is precisely the one where server state and the
 * physical relay have diverged.
 */
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

/**
 * Called on EVERY ingest and every GET /config. Returns the commands the
 * gateway should act on, and marks them delivered.
 *
 * Expiry is applied here rather than by a TTL index or a cron: this is the only
 * moment the answer actually matters, and doing it inline means a command can
 * never be handed to a device one tick after it should have died.
 *
 * A `sent` command is re-delivered while it is still live. That is intentional
 * — the ingest response can be lost on the way back to a gateway on a marginal
 * link, and the alternative (deliver exactly once) turns a dropped TCP response
 * into a spray the farmer asked for and never got. The firmware de-duplicates
 * on command id, so a re-delivery is a no-op there.
 */
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

/**
 * The gateway reporting what it actually did. Authenticated by device key, so
 * the command is matched on {id, device} — a valid key for one device can never
 * close out another device's command.
 */
export const acknowledgeCommand = async (device, commandId, payload = {}) => {
  const command = await ActuatorCommand.findOne({
    _id: commandId,
    device: device._id,
  });
  if (!command) throw httpError(404, "Command not found for this device");

  // A late ACK for something the queue already gave up on is recorded rather
  // than rejected: the relay genuinely fired, and pretending otherwise would
  // leave the daily budget under-counting real water.
  const wasTerminal = !LIVE_STATUSES.includes(command.status);

  const executed = payload.executed !== false;
  command.status = executed ? "acked" : "failed";
  command.ackedAt = new Date();
  command.result = {
    executed,
    actualRuntimeS: Number.isFinite(Number(payload.actualRuntimeS))
      ? Number(payload.actualRuntimeS)
      : undefined,
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

/**
 * Current actuator state for one device, for the dashboard control.
 * `busy` is what the UI disables the button on.
 */
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

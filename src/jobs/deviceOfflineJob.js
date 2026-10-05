import cron from "node-cron";
import config from "../config/env.js";
import Device from "../modules/telemetry/device.model.js";
import { isDeviceOnline } from "../modules/telemetry/device.service.js";
import { pushDeviceAlertIfDue } from "../modules/telemetry/telemetry.service.js";
import { emitToUser } from "../modules/chat/socket.js";
import { createLogger } from "../shared/utils/logger.js";

const logger = createLogger("DeviceOfflineJob");

export async function checkDevice(device) {
  if (isDeviceOnline(device)) return;

  const ownerRoom = String(device.owner);
  const alert = {
    deviceId: device._id,
    nodeLabel: device.nodeLabel,
    level: "warning",
    kind: "device_offline",
    message: device.lastSeenAt
      ? `${device.nodeLabel} has not reported since ${device.lastSeenAt.toISOString()}`
      : `${device.nodeLabel} has never reported`,
    value: device.lastSeenAt,
    threshold: config.deviceOfflineAfterS,
    at: new Date(),
  };

  emitToUser(ownerRoom, "telemetry_alert", alert);
  emitToUser(ownerRoom, "device_status", {
    deviceId: device._id,
    nodeLabel: device.nodeLabel,
    online: false,
    lastSeenAt: device.lastSeenAt,
    batteryMv: device.lastBatteryMv,
  });

  await pushDeviceAlertIfDue(device, alert);
}

let isRunning = false;

export async function runDeviceOfflineCheck() {
  if (isRunning) {
    logger.warn("Device offline sweep already in progress, skipping this tick");
    return;
  }
  isRunning = true;

  try {
    const devices = await Device.find({ isActive: true });
    logger.info(`Device offline sweep: checking ${devices.length} device(s)`);

    for (const device of devices) {
      try {
        await checkDevice(device);
      } catch (err) {
        logger.error(`Device offline check failed for device ${device._id}`, err.message);
      }
    }
  } finally {
    isRunning = false;
  }
}

export function startDeviceOfflineJob() {
  try {
    cron.schedule(config.deviceOfflineCheckCron, () => {
      runDeviceOfflineCheck().catch((err) =>
        logger.error("Device offline sweep failed", err.message),
      );
    });
    logger.info(`Device offline job scheduled: ${config.deviceOfflineCheckCron}`);
  } catch (err) {
    logger.error(
      `Failed to schedule device offline job (check DEVICE_OFFLINE_CHECK_CRON="${config.deviceOfflineCheckCron}")`,
      err.message,
    );
  }
}

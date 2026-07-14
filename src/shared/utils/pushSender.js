import { Expo } from "expo-server-sdk";
import config from "../../config/env.js";
import { createLogger } from "./logger.js";

const logger = createLogger("PushSender");

const expo = new Expo(
  config.expoAccessToken ? { accessToken: config.expoAccessToken } : {},
);

/**
 * Sends a single push notification via Expo's push service. Fire-and-forget
 * by design — callers should not await this on a hot path (e.g. delivering
 * a chat message). No receipt polling/retry in v1: a failed ticket is
 * logged, not retried. Silently no-ops on a missing/malformed token instead
 * of throwing, since "user hasn't registered a device yet" is routine, not
 * exceptional.
 */
export async function sendPushToUser(pushToken, { title, body, data } = {}) {
  if (!pushToken || !Expo.isExpoPushToken(pushToken)) {
    return { skipped: true };
  }

  const chunks = expo.chunkPushNotifications([
    { to: pushToken, sound: "default", title, body, data },
  ]);

  const tickets = [];
  for (const chunk of chunks) {
    try {
      tickets.push(...(await expo.sendPushNotificationsAsync(chunk)));
    } catch (err) {
      logger.error("Push send failed", err.message);
    }
  }

  const errorTicket = tickets.find((t) => t.status === "error");
  if (errorTicket) {
    logger.warn("Push ticket returned an error", errorTicket.message);
  }

  return { tickets };
}

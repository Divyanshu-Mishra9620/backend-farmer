import { Expo } from "expo-server-sdk";
import config from "../../config/env.js";
import { createLogger } from "./logger.js";

const logger = createLogger("PushSender");

const expo = new Expo(
  config.expoAccessToken ? { accessToken: config.expoAccessToken } : {},
);

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

import cron from "node-cron";
import config from "../config/env.js";
import User from "../modules/user/user.model.js";
import { UserPreferences } from "../modules/chat/chat.models.js";
import { geocodeAddress } from "../shared/utils/geocode.js";
import { fetchCurrentWeather } from "../shared/utils/weather.js";
import { sendPushToUser } from "../shared/utils/pushSender.js";
import { createLogger } from "../shared/utils/logger.js";

const logger = createLogger("WeatherAlertJob");

const HEAVY_RAIN_MM = 10;
const EXTREME_HEAT_C = 42;
const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

const ALERTS = [
  {
    type: "heavy_rain",
    cooldownField: "heavyRainAt",
    isTriggered: (weather) => weather.rain >= HEAVY_RAIN_MM,
    title: "Heavy rain alert",
    body: "Heavy rain is expected in your area. Take precautions for your crops and livestock.",
  },
  {
    type: "extreme_heat",
    cooldownField: "extremeHeatAt",
    isTriggered: (weather) => weather.temp >= EXTREME_HEAT_C,
    title: "Extreme heat alert",
    body: "Extreme heat is expected in your area. Ensure adequate water for your crops and livestock.",
  },
];

function isInCooldown(prefs, cooldownField) {
  const sentAt = prefs.lastWeatherAlert?.[cooldownField];
  return sentAt && Date.now() - new Date(sentAt).getTime() < COOLDOWN_MS;
}

async function ensureLocation(prefs, user) {
  const { lat, lon } = prefs.location?.coordinates || {};
  if (lat && lon) return { lat, lon };

  const geo = await geocodeAddress(
    `${user.address}, ${user.district}, ${user.state}`,
  );
  if (!geo) {
    logger.warn(`Could not geocode location for user ${user._id}`);
    return null;
  }

  // Patch only the fields this job owns rather than replacing the whole
  // subdocument, so a `village` set by some future feature isn't wiped out.
  prefs.location = prefs.location || {};
  prefs.location.state = user.state;
  prefs.location.district = user.district;
  prefs.location.coordinates = { lat: geo.lat, lon: geo.lon };

  return { lat: geo.lat, lon: geo.lon };
}

async function checkUser(user) {
  const prefs = await UserPreferences.findOneAndUpdate(
    { userId: user._id },
    { $setOnInsert: { userId: user._id } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  if (prefs.notificationPreferences?.weather === false) return;

  const location = await ensureLocation(prefs, user);
  if (!location) {
    await prefs.save();
    return;
  }

  const weather = await fetchCurrentWeather(location.lat, location.lon);
  let prefsChanged = prefs.isModified();

  for (const alert of ALERTS) {
    if (!alert.isTriggered(weather)) continue;
    if (isInCooldown(prefs, alert.cooldownField)) continue;

    const result = await sendPushToUser(user.pushToken, {
      title: alert.title,
      body: alert.body,
      data: { url: "krishiapp://home" },
    });

    // Only start the cooldown when a send was actually attempted — a
    // skipped send (missing/malformed token) shouldn't count as "alerted",
    // or the user silently stops receiving alerts for a full cycle.
    if (!result.skipped) {
      prefs.lastWeatherAlert = prefs.lastWeatherAlert || {};
      prefs.lastWeatherAlert[alert.cooldownField] = new Date();
      prefsChanged = true;
    }
  }

  if (prefsChanged) {
    await prefs.save();
  }
}

let isRunning = false;

export async function runWeatherAlertCheck() {
  if (isRunning) {
    logger.warn("Weather alert sweep already in progress, skipping this tick");
    return;
  }
  isRunning = true;

  try {
    const users = await User.find({ pushToken: { $ne: null } }).select(
      "address district state pushToken",
    );

    logger.info(`Weather alert sweep: checking ${users.length} user(s)`);

    for (const user of users) {
      try {
        await checkUser(user);
      } catch (err) {
        logger.error(`Weather alert check failed for user ${user._id}`, err.message);
      }
    }
  } finally {
    isRunning = false;
  }
}

export function startWeatherAlertJob() {
  try {
    cron.schedule(config.weatherAlertCron, () => {
      runWeatherAlertCheck().catch((err) =>
        logger.error("Weather alert sweep failed", err.message),
      );
    });
    logger.info(`Weather alert job scheduled: ${config.weatherAlertCron}`);
  } catch (err) {
    // An invalid WEATHER_ALERT_CRON must not take the whole server down —
    // node-cron validates the pattern synchronously and throws.
    logger.error(
      `Failed to schedule weather alert job (check WEATHER_ALERT_CRON="${config.weatherAlertCron}")`,
      err.message,
    );
  }
}

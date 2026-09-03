import dotenv from "dotenv";
dotenv.config();

if (!process.env.JWT_SECRET || !process.env.JWT_REFRESH_SECRET) {
  console.error(
    "JWT_SECRET and JWT_REFRESH_SECRET must be set. Refusing to start with insecure default secrets."
  );
  process.exit(1);
}

const config = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || "development",
  mongoUri: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
  emailUser: process.env.EMAIL_USER,
  emailPass: process.env.EMAIL_PASS,
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:3000",

  googleClientIds: (process.env.GOOGLE_CLIENT_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  allowedOrigins: (
    process.env.ALLOWED_ORIGINS ||
    "https://kris-hinova.vercel.app,http://localhost:3000,http://localhost:5173,http://localhost:5174"
  )
    .split(",")
    .map((s) => s.trim()),

  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME,
  cloudinaryApiKey: process.env.CLOUDINARY_API_KEY,
  cloudinaryApiSecret: process.env.CLOUDINARY_API_SECRET,

  groqApiKey: process.env.GROQ_API_KEY,
  geminiApiKey: process.env.GEMINI_API_KEY,
  openrouterApiKey: process.env.OPENROUTER_API_KEY,
  langgraphApiKey: process.env.LANGGRAPH_API_KEY,
  huggingFaceApiKey: process.env.HUGGINGFACE_API_KEY,
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
  maxUploadSize: parseInt(process.env.MAX_UPLOAD_SIZE || "5242880", 10),

  expoAccessToken: process.env.EXPO_ACCESS_TOKEN,
  weatherAlertCron: process.env.WEATHER_ALERT_CRON || "0 */3 * * *",

  // Optional. Baked into every stored device key hash, so introducing or
  // changing it invalidates all existing keys and every board has to be
  // re-registered or rotated — see src/modules/telemetry/deviceKey.js.
  deviceKeyPepper: process.env.DEVICE_KEY_PEPPER || "",
  deviceOfflineAfterS: parseInt(process.env.DEVICE_OFFLINE_AFTER_S || "900", 10),
  telemetryRetentionDays: parseInt(
    process.env.TELEMETRY_RETENTION_DAYS || "30",
    10
  ),
  telemetryMaxBatch: parseInt(process.env.TELEMETRY_MAX_BATCH || "50", 10),

  // --- Actuator (sprinkler) command queue ---------------------------------
  // A queued command that no gateway has collected within this window is
  // expired rather than delivered. This is the interlock that matters most: a
  // gateway that drops off WiFi mid-afternoon must NOT come back at dusk and
  // execute a spray the farmer authorised hours ago for conditions that no
  // longer exist. Keep it near the reading interval, not far above it.
  actuatorCommandTtlS: parseInt(process.env.ACTUATOR_COMMAND_TTL_S || "180", 10),
  // Hard ceiling on a single run, enforced server-side when the command is
  // queued AND again in firmware by a watchdog that cuts the relay. Two
  // independent limits because a stuck valve is the failure that floods a plot.
  actuatorMaxRuntimeS: parseInt(process.env.ACTUATOR_MAX_RUNTIME_S || "120", 10),
  // Minimum gap between two sprays on one device. Stops a farmer tapping the
  // button repeatedly (or a flapping detection) from waterlogging the root zone.
  actuatorCooldownS: parseInt(process.env.ACTUATOR_COOLDOWN_S || "900", 10),
  // Total relay-on seconds allowed per device per rolling 24 h.
  actuatorDailyBudgetS: parseInt(process.env.ACTUATOR_DAILY_BUDGET_S || "600", 10),
};

export default config;

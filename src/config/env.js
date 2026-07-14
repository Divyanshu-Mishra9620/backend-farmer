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
};

export default config;

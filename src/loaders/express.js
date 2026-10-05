import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import mongoose from "mongoose";
import config from "../config/env.js";
import routes from "../modules/index.js";
import errorHandler from "../shared/middlewares/errorHandler.js";
import { generalLimiter } from "../shared/middlewares/rateLimiter.js";
import { createLogger } from "../shared/utils/logger.js";
import { aiCache, weatherCache, geoCache } from "../shared/utils/cache.js";

const DB_STATE_LABELS = {
  0: "disconnected",
  1: "connected",
  2: "connecting",
  3: "disconnecting",
  99: "uninitialized",
};

const logger = createLogger("Express");

export default async function expressLoader() {
  const app = express();

  app.set("trust proxy", 1);

  app.use(
    helmet({
      crossOriginResourcePolicy: false,
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy: false,
    }),
  );

  const allowedOrigins = config.allowedOrigins;
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
          return callback(null, true);
        }
        logger.warn(`Blocked CORS request from origin: ${origin}`);
        return callback(new Error("Not allowed by CORS"));
      },
      credentials: true,
    }),
  );

  app.use(compression());

  if (process.env.NODE_ENV !== "test") {
    app.use(
      morgan("short", {
        stream: { write: (msg) => logger.info(msg.trim()) },
      }),
    );
  }

  app.use("/api", generalLimiter);

  app.use(express.static("public"));
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));
  app.use(cookieParser());

  app.get("/health", (req, res) => {
    const dbState = mongoose.connection.readyState;
    const dbConnected = dbState === 1;

    res.status(dbConnected ? 200 : 503).json({
      success: dbConnected,
      message: dbConnected
        ? "Farmer Assistant API is running"
        : "Farmer Assistant API is degraded",
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || "1.0.0",
      environment: config.nodeEnv,
      services: {
        database: DB_STATE_LABELS[dbState] || "unknown",
        ai_groq: config.groqApiKey ? "configured" : "not_configured",
        ai_gemini: config.geminiApiKey ? "configured" : "not_configured",
        ai_openrouter: config.openrouterApiKey
          ? "configured"
          : "not_configured",
        websocket: "available",
      },
      cache: {
        ai: aiCache.getStats(),
        weather: weatherCache.getStats(),
        geo: geoCache.getStats(),
      },
    });
  });

  app.use("/api", routes);

  app.get("/", (req, res) => {
    res.json({
      message: "🌾 Welcome to Farmer Assistant API",
      version: "1.0.0",
      documentation: "/health",
      websocket: "Connect to /socket.io for real-time chat",
      features: [
        "AI-powered farming advice",
        "Soil and plant image analysis",
        "Weather integration",
        "Market price information",
        "Real-time chat support",
      ],
    });
  });

  app.use((req, res) => {
    res.status(404).json({
      success: false,
      message: `Route ${req.originalUrl} not found`,
    });
  });

  app.use(errorHandler);

  return app;
}

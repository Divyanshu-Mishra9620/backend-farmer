import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
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

  // Security headers
  app.use(
    helmet({
      crossOriginResourcePolicy: false,
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy: false,
    }),
  );

  // CORS 
  const allowedOrigins = config.allowedOrigins;
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (
          allowedOrigins.includes("*") ||
          allowedOrigins.includes(origin)
        ) {
          return callback(null, true);
        }
        logger.warn(`Blocked CORS request from origin: ${origin}`);
        return callback(new Error("Not allowed by CORS"));
      },
      credentials: true,
    }),
  );

  // Compression
  app.use(compression());

  // Request logging
  if (process.env.NODE_ENV !== "test") {
    app.use(
      morgan("short", {
        stream: { write: (msg) => logger.info(msg.trim()) },
      }),
    );
  }

  // Rate limiting general
  app.use("/api", generalLimiter);

  // Body parsing
  app.use(express.static("public"));
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));

  // Health check
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

  // API routes
  app.use("/api", routes);

  // Root
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

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({
      success: false,
      message: `Route ${req.originalUrl} not found`,
    });
  });

  // Centralized error handler
  app.use(errorHandler);

  return app;
}

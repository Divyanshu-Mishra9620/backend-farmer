import { Router } from "express";
import {
  chatSuggest,
  geocodeAddress,
  getWeather,
  getMarketTrends,
  analyzeSoil,
} from "./chat.controller.js";
import { streamSuggestion, getSuggestion } from "./stream.controller.js";

import { uploadSingle } from "../../shared/utils/upload.js";
import { validateImageContent } from "../../shared/middlewares/validateImageContent.js";
import { authMiddleware } from "../../shared/middlewares/authMiddleware.js";
import {
  aiLimiter,
  streamLimiter,
} from "../../shared/middlewares/rateLimiter.js";

const router = Router();

router.post(
  "/suggestions/suggest-stream",
  authMiddleware,
  streamLimiter,
  streamSuggestion,
);
router.post(
  "/suggestions/suggest-direct",
  authMiddleware,
  aiLimiter,
  getSuggestion,
);

// Chat suggest (LangGraph pipeline)
router.post("/suggest", authMiddleware, aiLimiter, chatSuggest);

// Utility endpoints
router.post("/geo/geocode", authMiddleware, aiLimiter, geocodeAddress);
router.get("/weather/current", authMiddleware, aiLimiter, getWeather);
router.get("/market/trends", authMiddleware, aiLimiter, getMarketTrends);
router.post(
  "/soil/analyze",
  authMiddleware,
  aiLimiter,
  uploadSingle,
  validateImageContent,
  analyzeSoil,
);

export default router;

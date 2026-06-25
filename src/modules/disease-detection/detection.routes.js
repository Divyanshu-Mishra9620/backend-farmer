import { Router } from "express";
import { checkSchema, validationResult } from "express-validator";
import {
  uploadAndAnalyze,
  getAnalysisById,
  listUserAnalyses,
  getStats,
  retryAnalysis,
  deleteAnalysis,
} from "./detection.controller.js";
import { uploadSingle } from "../../shared/utils/upload.js";
import { authMiddleware } from "../../shared/middlewares/authMiddleware.js";
import { aiLimiter } from "../../shared/middlewares/rateLimiter.js";

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: errors.array(),
    });
  }
  next();
};

const router = Router();

const analysisValidation = {
  crop: {
    in: ["body"],
    optional: true,
    isString: true,
    isLength: { options: { min: 1, max: 100 } },
    trim: true,
  },
  district: {
    in: ["body"],
    optional: true,
    isString: true,
    isLength: { options: { min: 1, max: 100 } },
    trim: true,
  },
  state: {
    in: ["body"],
    optional: true,
    isString: true,
    isLength: { options: { min: 1, max: 100 } },
    trim: true,
  },
  provider: {
    in: ["body"],
    optional: true,
    isIn: {
      options: [["groq", "gemini", "huggingface"]],
      errorMessage: "Provider must be one of: groq, gemini, huggingface",
    },
  },
  latitude: {
    in: ["body"],
    optional: true,
    isFloat: { options: { min: -90, max: 90 } },
  },
  longitude: {
    in: ["body"],
    optional: true,
    isFloat: { options: { min: -180, max: 180 } },
  },
};

const listValidation = {
  limit: {
    in: ["query"],
    optional: true,
    isInt: { options: { min: 1, max: 100 } },
    toInt: true,
  },
  offset: {
    in: ["query"],
    optional: true,
    isInt: { options: { min: 0 } },
    toInt: true,
  },
  status: {
    in: ["query"],
    optional: true,
    isIn: {
      options: [["pending", "processing", "completed", "failed"]],
      errorMessage:
        "Status must be one of: pending, processing, completed, failed",
    },
  },
};

router.post(
  "/",
  authMiddleware,
  aiLimiter,
  uploadSingle,
  checkSchema(analysisValidation),
  validate,
  uploadAndAnalyze
);
router.get("/:id", authMiddleware, getAnalysisById);
router.get(
  "/",
  authMiddleware,
  checkSchema(listValidation),
  validate,
  listUserAnalyses
);
router.get("/stats/summary", authMiddleware, getStats);
router.post("/:id/retry", authMiddleware, aiLimiter, retryAnalysis);
router.delete("/:id", authMiddleware, deleteAnalysis);

export default router;

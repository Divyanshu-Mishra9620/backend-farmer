import path from "path";
import {
  analyzeImage,
  getAnalysis,
  listAnalyses,
  getAnalysisStats,
  retryFailedAnalysis,
} from "./detection.service.js";
import { safeErrorMessage } from "../../shared/utils/safeError.js";

export const uploadAndAnalyze = async (req, res, next) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({
        message: "Image file is required",
        error: "NO_FILE_UPLOADED",
      });
    }

    const allowedTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    if (!allowedTypes.includes(file.mimetype)) {
      return res.status(400).json({
        message: "Only JPEG, PNG, and WebP images are allowed",
        error: "INVALID_FILE_TYPE",
      });
    }

    const maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) {
      return res.status(400).json({
        message: "File size must be less than 10MB",
        error: "FILE_TOO_LARGE",
      });
    }

    const {
      crop,
      district,
      state,
      provider = "groq",
      latitude,
      longitude,
    } = req.body;
    const userId = req.user?.id || null;

    const location = {};
    if (district) location.district = district.trim();
    if (state) location.state = state.trim();
    if (latitude && longitude) {
      location.coordinates = {
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
      };
    }

    console.log(
      `Starting analysis for user ${userId}, crop: ${crop}, location: ${location.district}`
    );

    const analysis = await analyzeImage({
      filePath: file.path,
      originalName: file.originalname,
      userId,
      crop: crop?.trim(),
      location,
      provider,
    });

    return res.status(201).json({
      success: true,
      data: {
        id: analysis._id,
        status: analysis.status,
        imageUrl: analysis.imageUrl,
        crop: analysis.crop,
        location: analysis.location,
        detection: analysis.detection,
        recommendations: analysis.recommendations,
        confidence: analysis.confidencePercentage,
        provider: analysis.aiProvider,
        createdAt: analysis.createdAt,
        ...(analysis.status === "failed" && { error: analysis.error }),
      },
    });
  } catch (error) {
    console.error("Upload and analyze error:", error);

    let statusCode = 500;
    let errorCode = "ANALYSIS_FAILED";

    if (error.message.includes("API key")) {
      statusCode = 503;
      errorCode = "AI_SERVICE_UNAVAILABLE";
    } else if (error.message.includes("rate limit")) {
      statusCode = 429;
      errorCode = "RATE_LIMIT_EXCEEDED";
    } else if (error.message.includes("timeout")) {
      statusCode = 504;
      errorCode = "REQUEST_TIMEOUT";
    }

    return res.status(statusCode).json({
      success: false,
      message: "Failed to analyze image",
      error: errorCode,
      details: safeErrorMessage(error),
    });
  }
};

export const getAnalysisById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    if (!id || !id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({
        message: "Invalid analysis ID",
        error: "INVALID_ID",
      });
    }

    const analysis = await getAnalysis(id, userId);

    return res.json({
      success: true,
      data: {
        id: analysis._id,
        status: analysis.status,
        imageUrl: analysis.imageUrl,
        crop: analysis.crop,
        location: analysis.location,
        detection: analysis.detection,
        recommendations: analysis.recommendations,
        confidence: analysis.confidencePercentage,
        provider: analysis.aiProvider,
        createdAt: analysis.createdAt,
        updatedAt: analysis.updatedAt,
        processingSteps: analysis.processingSteps,
        ...(analysis.status === "failed" && { error: analysis.error }),
      },
    });
  } catch (error) {
    if (error.message === "Analysis not found") {
      return res.status(404).json({
        message: "Analysis not found",
        error: "NOT_FOUND",
      });
    }

    console.error("Get analysis error:", error);
    return res.status(500).json({
      message: "Failed to retrieve analysis",
      error: "RETRIEVAL_FAILED",
    });
  }
};

export const listUserAnalyses = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    const { limit = 20, offset = 0, status } = req.query;

    const parsedLimit = Math.min(parseInt(limit) || 20, 100);
    const parsedOffset = Math.max(parseInt(offset) || 0, 0);

    const result = await listAnalyses(userId, parsedLimit, parsedOffset);

    return res.json({
      success: true,
      data: result.analyses.map((analysis) => ({
        id: analysis._id,
        status: analysis.status,
        imageUrl: analysis.imageUrl,
        crop: analysis.crop,
        location: analysis.location,
        detection: analysis.detection,
        confidence: analysis.confidencePercentage,
        provider: analysis.aiProvider,
        createdAt: analysis.createdAt,
        ...(analysis.status === "failed" && { error: analysis.error }),
      })),
      pagination: {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        hasMore: result.hasMore,
      },
    });
  } catch (error) {
    console.error("List analyses error:", error);
    return res.status(500).json({
      message: "Failed to retrieve analyses",
      error: "LISTING_FAILED",
    });
  }
};

export const getStats = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    const stats = await getAnalysisStats(userId);

    return res.json({
      success: true,
      data: {
        total: stats.total,
        completed: stats.completed,
        failed: stats.failed,
        pending: stats.pending,
        processing: stats.processing,
        successRate:
          stats.total > 0
            ? ((stats.completed / stats.total) * 100).toFixed(1)
            : 0,
      },
    });
  } catch (error) {
    console.error("Get stats error:", error);
    return res.status(500).json({
      message: "Failed to retrieve statistics",
      error: "STATS_FAILED",
    });
  }
};

export const retryAnalysis = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    if (!id || !id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({
        message: "Invalid analysis ID",
        error: "INVALID_ID",
      });
    }

    const analysis = await retryFailedAnalysis(id, userId);

    return res.json({
      success: true,
      message: "Analysis retry initiated",
      data: {
        id: analysis._id,
        status: analysis.status,
        retryInitiatedAt: new Date(),
      },
    });
  } catch (error) {
    if (error.message === "Analysis not found") {
      return res.status(404).json({
        message: "Analysis not found",
        error: "NOT_FOUND",
      });
    }

    if (error.message === "Only failed analyses can be retried") {
      return res.status(400).json({
        message: "Only failed analyses can be retried",
        error: "INVALID_STATUS",
      });
    }

    console.error("Retry analysis error:", error);
    return res.status(500).json({
      message: "Failed to retry analysis",
      error: "RETRY_FAILED",
    });
  }
};

export const deleteAnalysis = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    if (!id || !id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({
        message: "Invalid analysis ID",
        error: "INVALID_ID",
      });
    }

    const analysis = await getAnalysis(id, userId);
    await analysis.deleteOne();

    return res.json({
      success: true,
      message: "Analysis deleted successfully",
    });
  } catch (error) {
    if (error.message === "Analysis not found") {
      return res.status(404).json({
        message: "Analysis not found",
        error: "NOT_FOUND",
      });
    }

    console.error("Delete analysis error:", error);
    return res.status(500).json({
      message: "Failed to delete analysis",
      error: "DELETE_FAILED",
    });
  }
};

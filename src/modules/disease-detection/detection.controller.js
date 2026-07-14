import path from "path";
import {
  analyzeImage,
  getAnalysis,
  listAnalyses,
  getAnalysisStats,
  retryFailedAnalysis,
} from "./detection.service.js";
import httpError from "../../shared/utils/httpError.js";

export const uploadAndAnalyze = async (req, res, next) => {
  try {
    const file = req.file;
    if (!file) {
      throw httpError(400, "Image file is required");
    }

    const allowedTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    if (!allowedTypes.includes(file.mimetype)) {
      throw httpError(400, "Only JPEG, PNG, and WebP images are allowed");
    }

    const maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) {
      throw httpError(400, "File size must be less than 10MB");
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
    if (error.isAppError) {
      return next(error);
    }

    // analyzeImage() rethrows whatever the AI pipeline/provider threw;
    // translate known failure reasons to the right status instead of a
    // blanket 500 so the client can tell "try again" apart from "wait".
    if (error.message?.includes("API key")) {
      return next(
        httpError(503, "The AI service is temporarily unavailable. Please try again shortly."),
      );
    }
    if (error.message?.includes("rate limit")) {
      return next(
        httpError(429, "Too many requests to the AI service. Please wait a moment and try again."),
      );
    }
    if (error.message?.includes("timeout")) {
      return next(
        httpError(504, "The AI service took too long to respond. Please try again."),
      );
    }

    next(httpError(500, "Failed to analyze image. Please try again."));
  }
};

export const getAnalysisById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    if (!id || !id.match(/^[0-9a-fA-F]{24}$/)) {
      throw httpError(400, "Invalid analysis ID");
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
    next(error);
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
    next(error);
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
    next(error);
  }
};

export const retryAnalysis = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    if (!id || !id.match(/^[0-9a-fA-F]{24}$/)) {
      throw httpError(400, "Invalid analysis ID");
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
    next(error);
  }
};

export const deleteAnalysis = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    if (!id || !id.match(/^[0-9a-fA-F]{24}$/)) {
      throw httpError(400, "Invalid analysis ID");
    }

    const analysis = await getAnalysis(id, userId);
    await analysis.deleteOne();

    return res.json({
      success: true,
      message: "Analysis deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};

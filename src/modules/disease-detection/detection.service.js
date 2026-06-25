import fs from "fs";
import path from "path";
import Analysis from "./analysis.mode.js";
import { executeAnalysisPipeline } from "./langraph.pipeline.js";
import { uploadToCloudinary } from "../../shared/utils/cloudinary.js";
import config from "../../config/env.js";

export const analyzeImage = async ({
  filePath,
  originalName,
  userId,
  crop,
  location = {},
  provider = "groq",
}) => {
  let analysis = null;

  try {
    const imageUrlFallback = `${config.frontendUrl?.replace(/\/$/, "") || "http://localhost:3000"}/uploads/${path.basename(filePath)}`;

    analysis = await Analysis.create({
      user: userId || null,
      imageUrl: imageUrlFallback,
      originalName,
      crop,
      location: {
        district: location.district,
        state: location.state,
        coordinates: location.coordinates,
      },
      aiProvider: provider,
      status: "pending",
      processingSteps: [
        {
          step: "creation",
          status: "completed",
          result: { message: "Analysis record created" },
        },
      ],
    });

    let imageUrl = imageUrlFallback;
    if (
      config.cloudinaryApiKey &&
      config.cloudinaryApiSecret &&
      config.cloudinaryCloudName
    ) {
      try {
        imageUrl = await uploadToCloudinary(filePath, {
          folder: "disease-analysis",
          transformation: [
            { width: 1000, height: 1000, crop: "limit" },
            { quality: "auto" },
          ],
        });

        analysis.imageUrl = imageUrl;
        await analysis.save();

        if (fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
          } catch (cleanupError) {
            console.error(
              "Failed to clean up local file after Cloudinary upload:",
              cleanupError
            );
          }
        }
      } catch (uploadError) {
        console.error(
          "Cloudinary upload failed, using local URL:",
          uploadError
        );
      }
    }

    const pipelineData = {
      analysisId: analysis._id.toString(),
      imageUrl,
      cropType: crop,
      location,
      provider,
    };

    console.log("Starting LangGraph pipeline...");
    const pipelineResult = await executeAnalysisPipeline(pipelineData);

    const updatedAnalysis = await Analysis.findById(analysis._id);

    if (!updatedAnalysis) {
      throw new Error("Analysis record not found after pipeline execution");
    }
    return updatedAnalysis;
  } catch (error) {
    console.error("Image analysis failed:", error);

    if (analysis) {
      analysis.status = "failed";
      analysis.error = error.message || String(error);
      analysis.processingSteps.push({
        step: "error_handling",
        status: "completed",
        error: error.message,
        result: { errorType: error.constructor.name },
      });
      await analysis.save();
    }

    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (cleanupError) {
        console.error("Failed to clean up local file:", cleanupError);
      }
    }

    throw error;
  }
};

export const getAnalysis = async (analysisId, userId = null) => {
  const query = { _id: analysisId };
  if (userId) query.user = userId;

  const analysis = await Analysis.findOne(query);
  if (!analysis) {
    throw new Error("Analysis not found");
  }

  return analysis;
};

export const listAnalyses = async (userId = null, limit = 50, offset = 0) => {
  const query = {};
  if (userId) query.user = userId;

  const analyses = await Analysis.find(query)
    .sort({ createdAt: -1 })
    .limit(limit)
    .skip(offset)
    .select("-rawResponses -processingSteps");

  const total = await Analysis.countDocuments(query);

  return {
    analyses,
    total,
    limit,
    offset,
    hasMore: offset + limit < total,
  };
};

export const getAnalysisStats = async (userId = null) => {
  const query = {};
  if (userId) query.user = userId;

  const stats = await Analysis.aggregate([
    { $match: query },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        completed: {
          $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
        },
        failed: {
          $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] },
        },
        pending: {
          $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
        },
        processing: {
          $sum: { $cond: [{ $eq: ["$status", "processing"] }, 1, 0] },
        },
      },
    },
  ]);

  return (
    stats[0] || {
      total: 0,
      completed: 0,
      failed: 0,
      pending: 0,
      processing: 0,
    }
  );
};

export const retryFailedAnalysis = async (analysisId, userId = null) => {
  const analysis = await getAnalysis(analysisId, userId);

  if (analysis.status !== "failed") {
    throw new Error("Only failed analyses can be retried");
  }

  analysis.status = "pending";
  analysis.error = null;
  analysis.processingSteps.push({
    step: "retry_initiated",
    status: "completed",
    result: { message: "Analysis retry initiated" },
  });
  await analysis.save();

  const pipelineData = {
    analysisId: analysis._id.toString(),
    imageUrl: analysis.imageUrl,
    cropType: analysis.crop,
    location: analysis.location,
    provider: analysis.aiProvider,
  };

  try {
    await executeAnalysisPipeline(pipelineData);
    return await Analysis.findById(analysisId);
  } catch (error) {
    console.error("Retry failed:", error);
    throw error;
  }
};

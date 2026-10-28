import fs from "fs";
import path from "path";
import Analysis from "./analysis.mode.js";
import User from "../user/user.model.js";
import { diagnoseDisease, RagDiagnosisError } from "./rag-diagnosis.client.js";
import { uploadToCloudinary } from "../../shared/utils/cloudinary.js";
import config from "../../config/env.js";
import httpError from "../../shared/utils/httpError.js";

// The RAG service writes mitigation in English or Hindi; anything else (or a
// failed lookup) gets English rather than failing the diagnosis.
export const diagnosisLanguageFor = async (userId) => {
  if (!userId) return "en";
  try {
    const user = await User.findById(userId).select("language").lean();
    return user?.language === "hi" ? "hi" : "en";
  } catch {
    return "en";
  }
};

function applyDiagnosis(analysis, result) {
  analysis.detection = {
    disease: result.prediction.disease,
    diseaseTitle: result.prediction.disease_title,
    confidence: result.prediction.confidence,
    status: result.status,
    source: result.source
      ? {
          title: result.source.title,
          sourceFile: result.source.source_file,
          scientificName: result.source.scientific_name,
        }
      : undefined,
    predictedBy: result.prediction.predicted_by === "edge" ? "edge" : "cloud",
    edgeModel: result.prediction.predicted_by === "edge" ? result.prediction.edge_model || undefined : undefined,
  };
  analysis.mitigation = result.mitigation || result.message || null;
  analysis.action = result.action || null;
  analysis.fieldSignals = Array.isArray(result.field_signals) ? result.field_signals : [];
}

export const analyzeImage = async ({
  filePath,
  originalName,
  userId,
  crop,
  location = {},
  provider = "groq",
  fieldContext = null,
  edgePrediction = null,
  language,
}) => {
  let analysis = null;
  // uploadToCloudinary() deletes the local file the moment the upload settles
  // (success or failure), so the diagnosis cannot read `filePath` afterwards.
  // It works from a private copy made before the upload instead.
  let diagnosisCopy = null;
  let uploadedUrl = null;

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
      fieldContext,
      edgePrediction,
      status: "pending",
      processingSteps: [
        {
          step: "creation",
          status: "completed",
          result: { message: "Analysis record created" },
        },
      ],
    });

    diagnosisCopy = path.join(path.dirname(filePath), `diag-${path.basename(filePath)}`);
    fs.copyFileSync(filePath, diagnosisCopy);

    if (
      config.cloudinaryApiKey &&
      config.cloudinaryApiSecret &&
      config.cloudinaryCloudName
    ) {
      try {
        analysis.imageUrl = await uploadToCloudinary(filePath, {
          folder: "disease-analysis",
          transformation: [
            { width: 1000, height: 1000, crop: "limit" },
            { quality: "auto" },
          ],
        });
        uploadedUrl = analysis.imageUrl;
        await analysis.save();
      } catch (uploadError) {
        console.error(
          "Cloudinary upload failed, using local URL:",
          uploadError
        );
      }
    }

    analysis.status = "processing";
    await analysis.save();

    const result = await diagnoseDisease({
      filePath: diagnosisCopy,
      userId,
      language: language || (await diagnosisLanguageFor(userId)),
      fieldContext,
      edgePrediction,
    });

    applyDiagnosis(analysis, result);
    analysis.status = "completed";
    analysis.processingSteps.push({
      step: "diagnosis",
      status: "completed",
      result: {
        status: result.status,
        inferenceTimeMs: result.prediction.inference_time_ms,
        predictedBy: analysis.detection.predictedBy,
      },
    });
    await analysis.save();

    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (cleanupError) {
        console.error("Failed to clean up local file after diagnosis:", cleanupError);
      }
    }

    return analysis;
  } catch (error) {
    console.error("Image analysis failed:", error);

    // Lets the caller still show the picture on a failed diagnosis, provided it
    // made it to Cloudinary.
    if (uploadedUrl && error && typeof error === "object") error.imageUrl = uploadedUrl;

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
  } finally {
    if (diagnosisCopy) fs.unlink(diagnosisCopy, () => {});
  }
};

export const getAnalysis = async (analysisId, userId = null) => {
  const query = { _id: analysisId };
  if (userId) query.user = userId;

  const analysis = await Analysis.findOne(query);
  if (!analysis) {
    throw httpError(404, "Analysis not found");
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
    throw httpError(400, "Only failed analyses can be retried");
  }

  analysis.status = "pending";
  analysis.error = null;
  analysis.processingSteps.push({
    step: "retry_initiated",
    status: "completed",
    result: { message: "Analysis retry initiated" },
  });
  await analysis.save();

  try {
    analysis.status = "processing";
    await analysis.save();

    const result = await diagnoseDisease({
      imageUrl: analysis.imageUrl,
      userId: analysis.user,
      language: await diagnosisLanguageFor(analysis.user),
      fieldContext: analysis.fieldContext || null,
      edgePrediction: analysis.edgePrediction || null,
    });

    applyDiagnosis(analysis, result);
    analysis.status = "completed";
    analysis.error = null;
    analysis.processingSteps.push({
      step: "diagnosis",
      status: "completed",
      result: {
        status: result.status,
        inferenceTimeMs: result.prediction.inference_time_ms,
      },
    });
    await analysis.save();

    return analysis;
  } catch (error) {
    console.error("Retry failed:", error);
    analysis.status = "failed";
    analysis.error = error.message || String(error);
    await analysis.save();
    throw error;
  }
};

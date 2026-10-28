import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import mongoose from "mongoose";

// analyzeImage() forwards the gateway's on-device prediction, records which
// model named the disease, and a retry offers the prediction again.

const diagnoseDisease = jest.fn();
const created = [];

jest.unstable_mockModule("../src/modules/disease-detection/rag-diagnosis.client.js", () => ({
  diagnoseDisease,
  RagDiagnosisError: class extends Error {},
}));
jest.unstable_mockModule("../src/shared/utils/cloudinary.js", () => ({
  uploadToCloudinary: async () => "https://img.example/leaf.jpg",
}));
jest.unstable_mockModule("../src/modules/user/user.model.js", () => ({
  default: { findById: () => ({ select: () => ({ lean: async () => null }) }) },
}));
jest.unstable_mockModule("../src/modules/disease-detection/analysis.mode.js", () => ({
  default: {
    create: async (doc) => {
      const row = { _id: new mongoose.Types.ObjectId(), processingSteps: [], fieldSignals: [], ...doc };
      row.processingSteps = [...(doc.processingSteps || [])];
      row.save = async () => row;
      created.push(row);
      return row;
    },
    findOne: async () => created.at(-1) || null,
  },
}));

const { analyzeImage, retryFailedAnalysis } = await import("../src/modules/disease-detection/detection.service.js");

const edgePrediction = { disease: "Tomato_Early_blight", confidence: 81.3, top_k: [], model: "mnv2_050-160-1a2b3c4d" };
const ragResult = (prediction = {}) => ({
  prediction: { disease: "Tomato_Early_blight", disease_title: "Tomato Early Blight", confidence: 81.3, ...prediction },
  status: "grounded",
  mitigation: "Spray ...",
  message: "ok",
  source: null,
  action: null,
  field_signals: [],
});

function tempUpload() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "diag-edge-")), "frame.jpg");
  fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff]));
  return file;
}

beforeEach(() => {
  diagnoseDisease.mockReset();
  created.length = 0;
});

it("records an edge diagnosis as such", async () => {
  diagnoseDisease.mockResolvedValue(ragResult({ predicted_by: "edge", edge_model: "mnv2_050-160-1a2b3c4d" }));
  const analysis = await analyzeImage({ filePath: tempUpload(), originalName: "f.jpg", userId: null, edgePrediction });

  expect(diagnoseDisease.mock.calls[0][0].edgePrediction).toBe(edgePrediction);
  expect(analysis.detection.predictedBy).toBe("edge");
  expect(analysis.detection.edgeModel).toBe("mnv2_050-160-1a2b3c4d");
  expect(analysis.edgePrediction).toBe(edgePrediction);
});

it("a cloud answer (or an older RAG service that does not say) is recorded as cloud", async () => {
  diagnoseDisease.mockResolvedValue(ragResult());
  const analysis = await analyzeImage({ filePath: tempUpload(), originalName: "f.jpg", userId: null });
  expect(diagnoseDisease.mock.calls[0][0].edgePrediction).toBeNull();
  expect(analysis.detection.predictedBy).toBe("cloud");
  expect(analysis.detection.edgeModel).toBeUndefined();
});

it("a retry offers the on-device prediction again", async () => {
  diagnoseDisease.mockRejectedValueOnce(new Error("RAG down"));
  const spy = jest.spyOn(console, "error").mockImplementation(() => {});
  await expect(
    analyzeImage({ filePath: tempUpload(), originalName: "f.jpg", userId: null, edgePrediction })
  ).rejects.toThrow("RAG down");
  diagnoseDisease.mockResolvedValue(ragResult({ predicted_by: "edge" }));
  await retryFailedAnalysis(created.at(-1)._id);
  spy.mockRestore();
  expect(diagnoseDisease.mock.calls.at(-1)[0].edgePrediction).toEqual(edgePrediction);
});

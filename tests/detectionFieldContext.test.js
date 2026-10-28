import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import mongoose from "mongoose";

// analyzeImage() must forward the field context and the farmer's language to
// the RAG service, store the field signals it returns next to the diagnosis,
// and keep the context on the record so a retry sends it again.

const diagnoseDisease = jest.fn();
const languageOf = new Map();
const created = [];

jest.unstable_mockModule("../src/modules/disease-detection/rag-diagnosis.client.js", () => ({
  diagnoseDisease,
  RagDiagnosisError: class extends Error {},
}));
jest.unstable_mockModule("../src/shared/utils/cloudinary.js", () => ({
  uploadToCloudinary: async () => "https://img.example/leaf.jpg",
}));
jest.unstable_mockModule("../src/modules/user/user.model.js", () => ({
  default: {
    findById: (id) => ({
      select: () => ({
        lean: async () => (languageOf.has(String(id)) ? { language: languageOf.get(String(id)) } : null),
      }),
    }),
  },
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

const { analyzeImage, retryFailedAnalysis, diagnosisLanguageFor } = await import(
  "../src/modules/disease-detection/detection.service.js"
);

const ragResult = (over = {}) => ({
  prediction: { disease: "Tomato_Early_blight", disease_title: "Tomato Early Blight", confidence: 91.2, inference_time_ms: 40 },
  status: "grounded",
  mitigation: "Your field right now ...",
  message: "ok",
  source: { title: "Tomato Early Blight", source_file: "tomato.pdf", scientific_name: "Alternaria solani" },
  action: { category: "fungal" },
  field_context: { latest: { soilMoisturePct: 18.4 } },
  field_signals: [{ code: "wet_spell", level: "warning", text: "Humidity was 85% or higher for 7 h", evidence: {} }],
  ...over,
});

function tempUpload() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "diag-")), "frame.jpg");
  fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff]));
  return file;
}

beforeEach(() => {
  diagnoseDisease.mockReset();
  languageOf.clear();
  created.length = 0;
});

it("forwards field context and the farmer's language, and stores the signals", async () => {
  const userId = new mongoose.Types.ObjectId();
  languageOf.set(String(userId), "hi");
  const fieldContext = { latest: { soilMoisturePct: 18.4 }, ageMinutes: 12 };
  diagnoseDisease.mockResolvedValue(ragResult());

  const analysis = await analyzeImage({ filePath: tempUpload(), originalName: "frame.jpg", userId, fieldContext });

  const [args] = diagnoseDisease.mock.calls[0];
  expect(args.fieldContext).toBe(fieldContext);
  expect(args.language).toBe("hi");
  expect(analysis.fieldContext).toBe(fieldContext);
  expect(analysis.fieldSignals).toEqual(ragResult().field_signals);
  expect(analysis.detection.status).toBe("grounded");
  expect(analysis.status).toBe("completed");
});

it("stores no signals when the RAG service sends none", async () => {
  diagnoseDisease.mockResolvedValue(ragResult({ field_context: null, field_signals: undefined }));
  const analysis = await analyzeImage({ filePath: tempUpload(), originalName: "frame.jpg", userId: null });
  expect(diagnoseDisease.mock.calls[0][0].fieldContext).toBeNull();
  expect(analysis.fieldSignals).toEqual([]);
});

it("a retry sends the stored field context again", async () => {
  const fieldContext = { latest: { soilMoisturePct: 30 }, ageMinutes: 5 };
  diagnoseDisease.mockRejectedValueOnce(new Error("RAG down"));
  const spy = jest.spyOn(console, "error").mockImplementation(() => {});
  await expect(
    analyzeImage({ filePath: tempUpload(), originalName: "frame.jpg", userId: null, fieldContext })
  ).rejects.toThrow("RAG down");

  diagnoseDisease.mockResolvedValue(ragResult());
  await retryFailedAnalysis(created.at(-1)._id);
  spy.mockRestore();

  expect(diagnoseDisease.mock.calls.at(-1)[0].fieldContext).toEqual(fieldContext);
});

it("only Hindi changes the diagnosis language", async () => {
  const hi = new mongoose.Types.ObjectId();
  const te = new mongoose.Types.ObjectId();
  languageOf.set(String(hi), "hi");
  languageOf.set(String(te), "te");
  expect(await diagnosisLanguageFor(hi)).toBe("hi");
  expect(await diagnosisLanguageFor(te)).toBe("en");
  expect(await diagnosisLanguageFor(new mongoose.Types.ObjectId())).toBe("en");
  expect(await diagnosisLanguageFor(null)).toBe("en");
});

import { jest } from "@jest/globals";
import mongoose from "mongoose";

// createCapture() must hand a finished diagnosis to raiseOutbreakAlerts with
// the camera as the source and the uploading gateway alongside, and a problem
// in the alerting must never turn a good diagnosis into a failed capture.

const raiseOutbreakAlerts = jest.fn(async () => ({ created: 0 }));
const analyzeImage = jest.fn();
const emitted = [];
const saved = [];

jest.unstable_mockModule("../src/modules/telemetry/outbreak.service.js", () => ({
  raiseOutbreakAlerts,
}));
jest.unstable_mockModule("../src/modules/disease-detection/detection.service.js", () => ({
  analyzeImage,
}));
jest.unstable_mockModule("../src/modules/chat/socket.js", () => ({
  emitToUser: (room, event, data) => emitted.push({ room, event, data }),
}));
jest.unstable_mockModule("../src/shared/utils/cloudinary.js", () => ({
  uploadToCloudinary: async () => "https://img.example/x.jpg",
}));
jest.unstable_mockModule("../src/modules/telemetry/capture.model.js", () => ({
  default: {
    create: async (doc) => {
      const row = { _id: new mongoose.Types.ObjectId(), ...doc };
      row.save = async () => saved.push({ status: row.status, error: row.error });
      return row;
    },
  },
}));
jest.unstable_mockModule("../src/modules/telemetry/device.model.js", () => ({
  default: { updateOne: async () => ({}) },
}));

let leaves = new Map();
jest.unstable_mockModule("../src/modules/telemetry/device.service.js", () => ({
  normalizeNodeLabel: (raw) => (typeof raw === "string" && raw.trim() ? raw.trim().toLowerCase() : null),
  resolveNodeDevices: async () => leaves,
}));
jest.unstable_mockModule("../src/modules/telemetry/telemetry.service.js", () => ({
  clampToServerTime: () => new Date(),
}));

const { createCapture } = await import("../src/modules/telemetry/capture.service.js");

const owner = new mongoose.Types.ObjectId();
const gateway = { _id: new mongoose.Types.ObjectId(), owner, type: "gateway", nodeLabel: "gw", isActive: true };
const camera = { _id: new mongoose.Types.ObjectId(), owner, type: "camera", nodeLabel: "plot-a-cam", plot: "A", isActive: true };
const file = { path: "/nonexistent/upload.jpg", originalname: "frame.jpg" };

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const goodAnalysis = () => ({
  _id: new mongoose.Types.ObjectId(),
  status: "completed",
  imageUrl: "https://img.example/x.jpg",
  detection: { disease: "Leaf_rust", confidence: 80, status: "grounded" },
  confidencePercentage: 80,
});

beforeEach(() => {
  raiseOutbreakAlerts.mockReset();
  raiseOutbreakAlerts.mockImplementation(async () => ({ created: 0 }));
  analyzeImage.mockReset();
  emitted.length = 0;
  saved.length = 0;
  leaves = new Map([["plot-a-cam", camera]]);
});

it("passes the camera (not the gateway) as the source", async () => {
  const analysis = goodAnalysis();
  analyzeImage.mockResolvedValue(analysis);

  await createCapture(gateway, file, { nodeLabel: "plot-a-cam" });
  await settle();

  expect(raiseOutbreakAlerts).toHaveBeenCalledTimes(1);
  const [args] = raiseOutbreakAlerts.mock.calls[0];
  expect(args.sourceDevice).toBe(camera);
  expect(args.gateway).toBe(gateway);
  expect(args.analysis).toBe(analysis);
  expect(args.capture.status).toBe("completed");
});

it("is not called when the diagnosis failed", async () => {
  analyzeImage.mockRejectedValue(new Error("RAG down"));
  const spy = jest.spyOn(console, "error").mockImplementation(() => {});
  await createCapture(gateway, file, { nodeLabel: "plot-a-cam" });
  await settle();
  spy.mockRestore();

  expect(raiseOutbreakAlerts).not.toHaveBeenCalled();
  expect(saved.at(-1).status).toBe("failed");
});

it("is not called when the analysis itself came back failed", async () => {
  analyzeImage.mockResolvedValue({ ...goodAnalysis(), status: "failed", error: "x" });
  await createCapture(gateway, file, { nodeLabel: "plot-a-cam" });
  await settle();
  expect(raiseOutbreakAlerts).not.toHaveBeenCalled();
});

it("an alerting crash leaves the capture completed, not failed", async () => {
  analyzeImage.mockResolvedValue(goodAnalysis());
  raiseOutbreakAlerts.mockImplementation(async () => {
    throw new Error("boom");
  });
  const spy = jest.spyOn(console, "error").mockImplementation(() => {});
  await createCapture(gateway, file, { nodeLabel: "plot-a-cam" });
  await settle();
  spy.mockRestore();

  expect(raiseOutbreakAlerts).toHaveBeenCalledTimes(1);
  expect(saved.map((s) => s.status)).not.toContain("failed");
  const analyzed = emitted.filter((e) => e.event === "device_capture_analyzed");
  expect(analyzed).toHaveLength(1);
  expect(analyzed[0].data.status).toBe("completed");
});

it("a frame from an unregistered label is attributed to the gateway itself", async () => {
  leaves = new Map();
  analyzeImage.mockResolvedValue(goodAnalysis());
  await createCapture(gateway, file, { nodeLabel: "unknown-cam" });
  await settle();
  expect(raiseOutbreakAlerts.mock.calls[0][0].sourceDevice).toBe(gateway);
});

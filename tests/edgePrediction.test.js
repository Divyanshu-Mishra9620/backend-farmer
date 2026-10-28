import { jest } from "@jest/globals";
import mongoose from "mongoose";

// The gateway's on-device prediction ("edge" form field on a capture upload):
// parsed leniently, stored on the capture, shown to the dashboard before the
// cloud diagnosis lands, offered to the RAG service as a stand-in for a dead
// cloud model, and never allowed to raise neighbour outbreak alerts.

const raiseOutbreakAlerts = jest.fn(async () => ({ created: 0 }));
const analyzeImage = jest.fn();
const emitted = [];
const createdCaptures = [];

jest.unstable_mockModule("../src/modules/telemetry/outbreak.service.js", () => ({ raiseOutbreakAlerts }));
jest.unstable_mockModule("../src/modules/disease-detection/detection.service.js", () => ({ analyzeImage }));
jest.unstable_mockModule("../src/modules/telemetry/fieldContext.service.js", () => ({
  buildFieldContext: async () => null,
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
      row.save = async () => row;
      createdCaptures.push(row);
      return row;
    },
  },
}));
jest.unstable_mockModule("../src/modules/telemetry/device.model.js", () => ({
  default: { updateOne: async () => ({}) },
}));
jest.unstable_mockModule("../src/modules/telemetry/device.service.js", () => ({
  normalizeNodeLabel: (raw) => (typeof raw === "string" && raw.trim() ? raw.trim().toLowerCase() : null),
  resolveNodeDevices: async () => new Map([["plot-a-cam", camera]]),
}));
jest.unstable_mockModule("../src/modules/telemetry/telemetry.service.js", () => ({
  clampToServerTime: () => new Date(),
}));

const { parseEdgeField, toRagEdgePrediction } = await import("../src/modules/telemetry/edgePrediction.js");
const { createCapture } = await import("../src/modules/telemetry/capture.service.js");

const owner = new mongoose.Types.ObjectId();
const gateway = { _id: new mongoose.Types.ObjectId(), owner, type: "gateway", nodeLabel: "gw", isActive: true };
const camera = { _id: new mongoose.Types.ObjectId(), owner, type: "camera", nodeLabel: "plot-a-cam", isActive: true };
const file = { path: "/nonexistent/upload.jpg", originalname: "frame.jpg" };
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

// Exactly what gateway_node.ino puts in the field.
const GATEWAY_FIELD = JSON.stringify({
  model: "mnv2_050-160-1a2b3c4d",
  label: "Tomato_Early_blight",
  confidence: 87.4,
  top: [
    { label: "Tomato_Early_blight", confidence: 87.4 },
    { label: "Tomato_Late_blight", confidence: 6.1 },
    { label: "Tomato_healthy", confidence: 2.0 },
  ],
  ms: 1830,
  decodeMs: 120,
});

const analysis = (detection) => ({
  _id: new mongoose.Types.ObjectId(),
  status: "completed",
  imageUrl: "https://img.example/x.jpg",
  detection: { disease: "Tomato_Early_blight", confidence: 87.4, status: "grounded", ...detection },
  confidencePercentage: 87,
});

beforeEach(() => {
  raiseOutbreakAlerts.mockClear();
  analyzeImage.mockReset();
  emitted.length = 0;
  createdCaptures.length = 0;
});

describe("parseEdgeField", () => {
  it("reads the gateway's field", () => {
    expect(parseEdgeField(GATEWAY_FIELD)).toEqual({
      label: "Tomato_Early_blight",
      confidence: 87.4,
      top: [
        { label: "Tomato_Early_blight", confidence: 87.4 },
        { label: "Tomato_Late_blight", confidence: 6.1 },
        { label: "Tomato_healthy", confidence: 2 },
      ],
      model: "mnv2_050-160-1a2b3c4d",
      inferenceMs: 1830,
      decodeMs: 120,
    });
  });

  it.each([
    undefined,
    null,
    "",
    "{nope",
    "[]",
    "42",
    JSON.stringify({ confidence: 50 }),
    JSON.stringify({ label: "Tomato_Early_blight" }),
    JSON.stringify({ label: "Tomato_Early_blight", confidence: 101 }),
    JSON.stringify({ label: "<img src=x>", confidence: 50 }),
    JSON.stringify({ label: "x".repeat(101), confidence: 50 }),
    "x".repeat(3000),
    { label: "not-a-string-field", confidence: 5 },
  ])("drops %p", (raw) => {
    expect(parseEdgeField(raw)).toBeNull();
  });

  it("keeps the prediction but drops bad extras", () => {
    const edge = parseEdgeField(
      JSON.stringify({ label: "Leaf_rust", confidence: "61.26", top: [{ label: 3 }, "x"], model: "bad id!", ms: -4 })
    );
    expect(edge).toEqual({
      label: "Leaf_rust",
      confidence: 61.3,
      top: [{ label: "Leaf_rust", confidence: 61.3 }],
      model: null,
      inferenceMs: null,
      decodeMs: null,
    });
  });

  it("converts to the RAG service's field", () => {
    expect(toRagEdgePrediction(parseEdgeField(GATEWAY_FIELD))).toEqual({
      disease: "Tomato_Early_blight",
      confidence: 87.4,
      top_k: [
        { disease: "Tomato_Early_blight", confidence: 87.4 },
        { disease: "Tomato_Late_blight", confidence: 6.1 },
        { disease: "Tomato_healthy", confidence: 2 },
      ],
      model: "mnv2_050-160-1a2b3c4d",
      inference_time_ms: 1830,
    });
    expect(toRagEdgePrediction(null)).toBeNull();
  });
});

describe("createCapture with an on-device prediction", () => {
  it("stores it, shows it straight away and offers it to the RAG service", async () => {
    analyzeImage.mockResolvedValue(analysis({ predictedBy: "cloud" }));
    const result = await createCapture(gateway, file, { nodeLabel: "plot-a-cam", edge: GATEWAY_FIELD });
    await settle();

    expect(createdCaptures[0].edge.label).toBe("Tomato_Early_blight");
    expect(result.edge.model).toBe("mnv2_050-160-1a2b3c4d");
    const received = emitted.find((e) => e.event === "device_capture_received");
    expect(received.data.edge.confidence).toBe(87.4);
    expect(analyzeImage.mock.calls[0][0].edgePrediction.disease).toBe("Tomato_Early_blight");

    const analyzed = emitted.find((e) => e.event === "device_capture_analyzed");
    expect(analyzed.data.predictedBy).toBe("cloud");
    expect(analyzed.data.edge.label).toBe("Tomato_Early_blight");
    expect(raiseOutbreakAlerts).toHaveBeenCalledTimes(1);
  });

  it("a diagnosis made from the on-device prediction does not alert the neighbours", async () => {
    analyzeImage.mockResolvedValue(analysis({ predictedBy: "edge", edgeModel: "mnv2_050-160-1a2b3c4d" }));
    await createCapture(gateway, file, { nodeLabel: "plot-a-cam", edge: GATEWAY_FIELD });
    await settle();

    const analyzed = emitted.find((e) => e.event === "device_capture_analyzed");
    expect(analyzed.data.status).toBe("completed");
    expect(analyzed.data.predictedBy).toBe("edge");
    expect(raiseOutbreakAlerts).not.toHaveBeenCalled();
  });

  it("a failed diagnosis still carries the on-device result to the dashboard", async () => {
    analyzeImage.mockRejectedValue(new Error("Diagnosis service error (503)"));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    await createCapture(gateway, file, { nodeLabel: "plot-a-cam", edge: GATEWAY_FIELD });
    await settle();
    spy.mockRestore();

    const analyzed = emitted.find((e) => e.event === "device_capture_analyzed");
    expect(analyzed.data.status).toBe("failed");
    expect(analyzed.data.edge.label).toBe("Tomato_Early_blight");
  });

  it("a malformed field never rejects the photo", async () => {
    analyzeImage.mockResolvedValue(analysis({}));
    const result = await createCapture(gateway, file, { nodeLabel: "plot-a-cam", edge: "{garbage" });
    await settle();

    expect(result.edge).toBeNull();
    expect(analyzeImage.mock.calls[0][0].edgePrediction).toBeNull();
    const analyzed = emitted.find((e) => e.event === "device_capture_analyzed");
    expect(analyzed.data.predictedBy).toBe("cloud");
  });
});

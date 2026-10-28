import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

// The gateway's on-device prediction travels to the RAG service as one JSON
// form field, edge_prediction, next to the image.

const appended = [];

jest.unstable_mockModule("form-data", () => ({
  default: class {
    append(name, value) {
      appended.push([name, value]);
    }
    getHeaders() {
      return { "content-type": "multipart/form-data; boundary=x" };
    }
  },
}));
jest.unstable_mockModule("node-fetch", () => ({
  default: async () => ({ ok: true, json: async () => ({ status: "grounded" }) }),
}));

const { diagnoseDisease } = await import("../src/modules/disease-detection/rag-diagnosis.client.js");

const image = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rag-edge-")), "leaf.jpg");
fs.writeFileSync(image, Buffer.from([0xff, 0xd8, 0xff]));

beforeEach(() => {
  appended.length = 0;
});

it("adds edge_prediction as JSON when there is one", async () => {
  const edgePrediction = { disease: "Leaf_rust", confidence: 71.2, top_k: [], model: "m", inference_time_ms: 900 };
  await diagnoseDisease({ filePath: image, userId: "u1", edgePrediction });
  const field = appended.find(([name]) => name === "edge_prediction");
  expect(JSON.parse(field[1])).toEqual(edgePrediction);
});

it("sends no edge_prediction without one", async () => {
  await diagnoseDisease({ filePath: image, userId: "u1" });
  expect(appended.map(([name]) => name)).toEqual(["file"]);
});

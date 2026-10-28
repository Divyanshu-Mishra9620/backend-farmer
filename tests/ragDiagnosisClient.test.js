import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

// The field context travels as one JSON form field next to the image.

const appended = [];
let fetchCall = null;

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
  default: async (url, options) => {
    fetchCall = { url, options };
    return { ok: true, json: async () => ({ status: "grounded" }) };
  },
}));

const { diagnoseDisease } = await import("../src/modules/disease-detection/rag-diagnosis.client.js");

const image = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rag-client-")), "leaf.jpg");
fs.writeFileSync(image, Buffer.from([0xff, 0xd8, 0xff]));

beforeEach(() => {
  appended.length = 0;
  fetchCall = null;
});

it("adds field_context as JSON when there is one", async () => {
  const fieldContext = { latest: { soilMoisturePct: 18.4 } };
  await diagnoseDisease({ filePath: image, userId: "u1", language: "hi", fieldContext });
  const field = appended.find(([name]) => name === "field_context");
  expect(JSON.parse(field[1])).toEqual(fieldContext);
  expect(fetchCall.url).toContain("language=hi");
});

it("sends no field_context field without one", async () => {
  await diagnoseDisease({ filePath: image, userId: "u1" });
  expect(appended.map(([name]) => name)).toEqual(["file"]);
});

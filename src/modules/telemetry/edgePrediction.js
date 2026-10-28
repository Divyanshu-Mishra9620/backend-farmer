// The gateway's own diagnosis of a photo.
//
// The field gateway (ESP32-S3) runs a small int8 copy of the disease model on
// every camera frame before uploading it, and sends the result as the "edge"
// multipart field next to the image:
//
//   {"model":"mnv2_050-160-1a2b3c4d","label":"Tomato_Early_blight","confidence":87.4,
//    "top":[{"label":"Tomato_Early_blight","confidence":87.4}, ...],"ms":1830,"decodeMs":120}
//
// It is stored on the capture and shown next to the cloud diagnosis, and it is
// forwarded to the RAG service, which uses it only if the cloud model cannot
// answer. A malformed field is dropped, never a reason to reject the photo:
// the gateway treats a 4xx as permanent and would throw the frame away.

const LABEL = /^[\w\-() ,.&']{1,100}$/;
const MODEL_ID = /^[\w.-]{1,64}$/;
export const MAX_EDGE_FIELD_BYTES = 2048;

const cleanLabel = (value) =>
  typeof value === "string" && LABEL.test(value.trim()) ? value.trim() : null;

const cleanPercent = (value) => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 10) / 10;
};

const cleanMs = (value) =>
  Number.isInteger(value) && value >= 0 && value <= 600000 ? value : null;

export function parseEdgeField(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_EDGE_FIELD_BYTES) return null;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  const label = cleanLabel(payload.label);
  const confidence = cleanPercent(payload.confidence);
  if (!label || confidence == null) return null;

  const top = (Array.isArray(payload.top) ? payload.top.slice(0, 5) : [])
    .map((item) => ({ label: cleanLabel(item?.label), confidence: cleanPercent(item?.confidence) }))
    .filter((item) => item.label && item.confidence != null);

  return {
    label,
    confidence,
    top: top.length ? top : [{ label, confidence }],
    model: typeof payload.model === "string" && MODEL_ID.test(payload.model) ? payload.model : null,
    inferenceMs: cleanMs(payload.ms),
    decodeMs: cleanMs(payload.decodeMs),
  };
}

// The shape the RAG service's `edge_prediction` form field expects.
export function toRagEdgePrediction(edge) {
  if (!edge) return null;
  return {
    disease: edge.label,
    confidence: edge.confidence,
    top_k: edge.top.map((item) => ({ disease: item.label, confidence: item.confidence })),
    model: edge.model,
    inference_time_ms: edge.inferenceMs,
  };
}

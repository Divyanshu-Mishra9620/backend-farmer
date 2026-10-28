import fetch from "node-fetch";
import FormData from "form-data";
import fs from "fs";
import jwt from "jsonwebtoken";
import config from "../../config/env.js";

export class RagDiagnosisError extends Error {}

const RAG_TIMEOUT_MS = 300000;

function mintServiceToken(userId) {
  return jwt.sign({ id: userId, role: "user" }, config.jwtSecret, {
    expiresIn: "5m",
  });
}

async function appendImage(form, { filePath, imageUrl }) {
  if (filePath) {
    form.append("file", fs.createReadStream(filePath));
    return;
  }
  if (!imageUrl) {
    throw new RagDiagnosisError("diagnoseDisease requires either filePath or imageUrl.");
  }
  let imgResponse;
  try {
    imgResponse = await fetch(imageUrl);
  } catch (err) {
    throw new RagDiagnosisError(`Could not fetch image from ${imageUrl}: ${err.message}`);
  }
  if (!imgResponse.ok) {
    throw new RagDiagnosisError(`Could not fetch image from ${imageUrl}: ${imgResponse.status}`);
  }
  const buffer = Buffer.from(await imgResponse.arrayBuffer());
  form.append("file", buffer, {
    filename: "image.jpg",
    contentType: imgResponse.headers.get("content-type") || "image/jpeg",
  });
}

// `fieldContext` (optional) is what the farmer's sensor measured on the field
// the photo came from (see telemetry/fieldContext.service.js). The RAG service
// turns it into field signals next to the grounded write-up; it never changes
// the diagnosis itself.
//
// `edgePrediction` (optional) is the field gateway's on-device prediction for a
// camera photo (see telemetry/edgePrediction.js). The RAG service uses it only
// when its cloud ML model cannot answer, and reports prediction.predicted_by.
export async function diagnoseDisease({
  filePath,
  imageUrl,
  userId,
  language = "en",
  topK = 3,
  fieldContext = null,
  edgePrediction = null,
}) {
  if (!config.ragApiUrl) {
    throw new RagDiagnosisError("RAG_API_URL is not configured.");
  }

  const form = new FormData();
  await appendImage(form, { filePath, imageUrl });
  if (fieldContext) {
    form.append("field_context", JSON.stringify(fieldContext));
  }
  if (edgePrediction) {
    form.append("edge_prediction", JSON.stringify(edgePrediction));
  }

  const url = `${config.ragApiUrl.replace(/\/$/, "")}/api/diagnose-disease?top_k=${topK}&language=${encodeURIComponent(language)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RAG_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mintServiceToken(userId)}`,
        ...form.getHeaders(),
      },
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    throw new RagDiagnosisError(
      err.name === "AbortError"
        ? `Diagnosis service timed out after ${RAG_TIMEOUT_MS / 1000}s.`
        : `Could not reach the diagnosis service: ${err.message}`,
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new RagDiagnosisError(`Diagnosis service error (${response.status}): ${detail.slice(0, 300)}`);
  }

  return response.json();
}

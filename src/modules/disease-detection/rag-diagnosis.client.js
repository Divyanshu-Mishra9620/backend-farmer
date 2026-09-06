import fetch from "node-fetch";
import FormData from "form-data";
import fs from "fs";
import jwt from "jsonwebtoken";
import config from "../../config/env.js";

export class RagDiagnosisError extends Error {}

/**
 * The RAG service issues no tokens of its own — it verifies the same HS256
 * JWT this backend signs on login, using the shared JWT_SECRET (see
 * rag/app/core/security.py). Minting one here on behalf of the image's owner
 * lets a device-authenticated hardware capture (which has no farmer JWT in
 * its own request) reach the RAG service's per-user-authenticated diagnosis
 * endpoint without inventing a second trust boundary. Five minutes is only
 * ever exercised for the seconds this one call takes.
 */
function mintServiceToken(userId) {
  return jwt.sign({ id: userId, role: "user" }, config.jwtSecret, {
    expiresIn: "5m",
  });
}

// A fresh analysis has the local temp file; a retry (analysis.imageUrl only,
// the original upload is long gone) has to re-fetch the durable Cloudinary
// copy instead — the RAG endpoint needs actual image bytes, not a URL.
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

/**
 * Calls the RAG service's grounded disease-mitigation pipeline: ML classifier
 * -> knowledge-base document -> LLM answer strictly grounded in that
 * document, or an honest "healthy" / "no verified info" message with no LLM
 * call at all. Replaces the old raw vision-LLM one-shot guess (ai-providers.js)
 * for every caller of analyzeImage() — that path had no knowledge base, no
 * citation, and threw away most of what it invented before saving anyway.
 *
 * Pass filePath for a fresh upload (still on local disk) or imageUrl for a
 * retry (only the durable Cloudinary copy survives).
 *
 * Raises RagDiagnosisError on any failure — the caller must show "diagnosis
 * unavailable", not silently fall back to a guess.
 */
export async function diagnoseDisease({ filePath, imageUrl, userId, language = "en", topK = 3 }) {
  if (!config.ragApiUrl) {
    throw new RagDiagnosisError("RAG_API_URL is not configured.");
  }

  const form = new FormData();
  await appendImage(form, { filePath, imageUrl });

  const url = `${config.ragApiUrl.replace(/\/$/, "")}/api/diagnose-disease?top_k=${topK}&language=${encodeURIComponent(language)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 90000);

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
        ? "Diagnosis service timed out after 90s."
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

import fs from "fs";
import { uploadToCloudinary } from "./cloudinary.js";
import config from "../../config/env.js";
import httpError from "./httpError.js";

const cloudinaryConfigured = () =>
  Boolean(
    config.cloudinaryCloudName &&
      config.cloudinaryApiKey &&
      config.cloudinaryApiSecret,
  );

/**
 * Turns a multer-staged upload into a durable, publicly reachable URL.
 *
 * This exists because the community modules used to persist
 * `${req.protocol}://${req.get("host")}/uploads/${filename}` — a URL backed
 * only by the container's own filesystem. The Mongo document kept that URL
 * forever; the bytes did not survive the next redeploy, restart or instance
 * recycle, so every older image 404'd and the browser fell back to alt text.
 *
 * Two deliberate rules:
 *
 *   1. Cloudinary is required, not preferred. If it isn't configured we fail
 *      with a 503 rather than storing a host-local URL, because a URL that
 *      resolves on a laptop and dies in production is worse than an honest
 *      error — that asymmetry is exactly how the original bug shipped.
 *   2. An upload failure is also a hard failure. The older pattern elsewhere
 *      in this codebase logs the error and keeps a local fallback
 *      (see detection.service.js); that is what silently writes dead URLs
 *      into the database, so it is not copied here.
 *
 * Returns null when no file was attached (a text-only post is valid).
 * uploadToCloudinary owns the staging file and unlinks it on both paths.
 */
export const resolveUploadedImageUrl = async (file, folder) => {
  if (!file) return null;

  if (!cloudinaryConfigured()) {
    // Nothing else will remove the staging file, since we never reach
    // uploadToCloudinary on this path.
    fs.unlink(file.path, () => {});
    throw httpError(
      503,
      "Image uploads are unavailable: the image store is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.",
    );
  }

  try {
    return await uploadToCloudinary(file.path, {
      folder,
      transformation: [
        { width: 1600, height: 1600, crop: "limit" },
        { quality: "auto" },
      ],
    });
  } catch (err) {
    throw httpError(502, `Image upload failed: ${err.message}`);
  }
};

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

export const resolveUploadedImageUrl = async (file, folder) => {
  if (!file) return null;

  if (!cloudinaryConfigured()) {
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

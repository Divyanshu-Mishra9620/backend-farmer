import fs from "fs/promises";
import { fileTypeFromFile } from "file-type";

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export async function validateImageContent(req, res, next) {
  const file = req.file;
  if (!file) return next();

  try {
    const type = await fileTypeFromFile(file.path);
    if (!type || !ALLOWED_IMAGE_TYPES.has(type.mime)) {
      await fs.unlink(file.path).catch(() => {});
      const error = new Error("Invalid image file. Please upload a real photo.");
      error.status = 400;
      return next(error);
    }
    next();
  } catch (err) {
    await fs.unlink(file.path).catch(() => {});
    next(err);
  }
}

import multer from "multer";
import path from "path";
import fs from "fs";
import config from "../../config/env.js";

// Staging only — the durable copy lives on Cloudinary, and the handlers
// (FarmersCommunity/postController.js, communityChat/communityChat.controller.js)
// unlink this file once it is uploaded. Deliberately NOT under public/, which
// express.static serves: writing uploads somewhere web-reachable is what led
// to image URLs pointing at the container's own disk, which then 404 as soon
// as the container is redeployed or recycled.
//
// mkdir because multer's diskStorage does not create the directory itself —
// a fresh checkout or a fresh container would otherwise ENOENT on first upload.
const uploadDir = path.resolve(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(
      null,
      file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname)
    );
  },
});

const fileFilter = (req, file, cb) => {
  if (!file.mimetype.startsWith("image/")) {
    return cb(new Error("Only image files are allowed"), false);
  }
  cb(null, true);
};

const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadSize },
  fileFilter,
});

export default upload;

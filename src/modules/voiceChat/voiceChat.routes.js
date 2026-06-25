import { Router } from "express";
import multer from "multer";
import {
  startVoiceSession,
  processVoiceQuery,
  endVoiceSession,
  getVoiceChatHistory,
} from "./voiceChat.controller.js";
import { authMiddleware } from "../../shared/middlewares/authMiddleware.js";
import { aiLimiter } from "../../shared/middlewares/rateLimiter.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("audio/")) {
      cb(null, true);
    } else {
      cb(new Error("Only audio files are allowed"), false);
    }
  },
});

router.post("/start-session", authMiddleware, startVoiceSession);
router.post(
  "/process-audio",
  authMiddleware,
  aiLimiter,
  (req, res, next) => {
    upload.single("audio")(req, res, (err) => {
      if (err) {
        console.error("[Voice] Multer error:", err);
        return res.status(400).json({
          success: false,
          message: "File upload error",
          error: err.message,
        });
      }
      console.log("[Voice] Multer processed successfully");
      console.log("[Voice] req.body:", req.body);
      console.log("[Voice] req.file:", req.file ? "exists" : "missing");
      next();
    });
  },
  processVoiceQuery
);
router.post("/end-session", authMiddleware, endVoiceSession);
router.get("/history", authMiddleware, getVoiceChatHistory);

export default router;

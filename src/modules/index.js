import { Router } from "express";
import userRoutes from "./user/user.routes.js";
import authRoutes from "./auth/auth.routes.js";
import diseaseDetectionRoutes from "./disease-detection/detection.routes.js";
import chatRoutes from "./chat/chat.routes.js";
import communityChatRoutes from "./communityChat/communityChat.routes.js";
import voiceChatRoutes from "./voiceChat/voiceChat.routes.js";
import postRoutes from "./FarmersCommunity/postRoutes.js";
import commentRoutes from "./FarmersCommunity/commentRoutes.js";
import schemeRoutes from "./schemes/scheme.routes.js";

const router = Router();

router.use("/user", userRoutes);
router.use("/auth", authRoutes);
router.use("/disease-detection", diseaseDetectionRoutes);
router.use("/", chatRoutes);
router.use("/community", communityChatRoutes);
router.use("/voice-chat", voiceChatRoutes);
router.use("/posts", postRoutes);
router.use("/comments", commentRoutes);
router.use("/schemes", schemeRoutes);

router.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "API is running",
  });
});

export default router;

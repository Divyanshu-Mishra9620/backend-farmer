import { Router } from "express";
import { body, param, query } from "express-validator";
import * as communityController from "./communityChat.controller.js";
import { authMiddleware as authenticateToken } from "../../shared/middlewares/authMiddleware.js";

const router = Router();

router.use(authenticateToken);

const createChannelValidation = [
  body("name")
    .trim()
    .isLength({ min: 3, max: 50 })
    .withMessage("Channel name must be between 3 and 50 characters"),
  body("description")
    .trim()
    .isLength({ min: 10, max: 200 })
    .withMessage("Description must be between 10 and 200 characters"),
  body("category")
    .isIn([
      "crop_cultivation",
      "pest_management",
      "weather_discussion",
      "market_prices",
      "farming_techniques",
      "equipment_tools",
      "organic_farming",
      "government_schemes",
      "general_discussion",
    ])
    .withMessage("Invalid category"),
  body("icon")
    .optional()
    .isString()
    .isLength({ max: 10 })
    .withMessage("Icon must be a string with max 10 characters"),
];

const sendMessageValidation = [
  body("content")
    .trim()
    .isLength({ min: 1, max: 1000 })
    .withMessage("Message content must be between 1 and 1000 characters"),
  body("messageType")
    .optional()
    .isIn(["text", "image", "link", "poll"])
    .withMessage("Invalid message type"),
  body("mentions")
    .optional()
    .isArray()
    .withMessage("Mentions must be an array"),
  body("mentions.*")
    .optional()
    .isMongoId()
    .withMessage("Invalid user ID in mentions"),
];

const reactionValidation = [
  body("emoji")
    .isIn(["👍", "❤️", "😊", "👏", "🤔", "😢"])
    .withMessage("Invalid emoji"),
];

const updateChannelValidation = [
  body("name")
    .optional()
    .trim()
    .isLength({ min: 3, max: 50 })
    .withMessage("Channel name must be between 3 and 50 characters"),
  body("description")
    .optional()
    .trim()
    .isLength({ min: 10, max: 200 })
    .withMessage("Description must be between 10 and 200 characters"),
  body("icon")
    .optional()
    .isString()
    .isLength({ max: 10 })
    .withMessage("Icon must be a string with max 10 characters"),
];

router.get("/channels", communityController.getChannels);
router.post(
  "/channels",
  createChannelValidation,
  communityController.createChannel
);
router.get("/channels/my", communityController.getUserChannels);
router.get(
  "/channels/:channelId",
  param("channelId").isMongoId().withMessage("Invalid channel ID"),
  communityController.getChannel
);
router.put(
  "/channels/:channelId",
  param("channelId").isMongoId().withMessage("Invalid channel ID"),
  updateChannelValidation,
  communityController.updateChannel
);

router.post(
  "/channels/:channelId/join",
  param("channelId").isMongoId().withMessage("Invalid channel ID"),
  communityController.joinChannel
);
router.post(
  "/channels/:channelId/leave",
  param("channelId").isMongoId().withMessage("Invalid channel ID"),
  communityController.leaveChannel
);
router.get(
  "/channels/:channelId/members",
  param("channelId").isMongoId().withMessage("Invalid channel ID"),
  communityController.getChannelMembers
);

router.get(
  "/channels/:channelId/messages",
  param("channelId").isMongoId().withMessage("Invalid channel ID"),
  communityController.getChannelMessages
);
router.post(
  "/channels/:channelId/messages",
  param("channelId").isMongoId().withMessage("Invalid channel ID"),
  sendMessageValidation,
  communityController.sendMessage
);

router.post(
  "/messages/:messageId/reactions",
  param("messageId").isMongoId().withMessage("Invalid message ID"),
  reactionValidation,
  communityController.addReaction
);
router.delete(
  "/messages/:messageId/reactions",
  param("messageId").isMongoId().withMessage("Invalid message ID"),
  reactionValidation,
  communityController.removeReaction
);

router.delete(
  "/messages/:messageId",
  param("messageId").isMongoId().withMessage("Invalid message ID"),
  communityController.deleteMessage
);

router.post(
  "/messages/:messageId/pin",
  param("messageId").isMongoId().withMessage("Invalid message ID"),
  communityController.togglePin
);

router.get(
  "/channels/:channelId/pinned-messages",
  param("channelId").isMongoId().withMessage("Invalid channel ID"),
  communityController.getPinnedMessages
);

router.get(
  "/channels/:channelId/analytics",
  param("channelId").isMongoId().withMessage("Invalid channel ID"),
  query("days").optional().isInt({ min: 1, max: 90 }),
  communityController.getChannelAnalytics
);

router.get(
  "/search",
  query("query").trim().notEmpty().withMessage("Search query is required"),
  query("channelId").optional().isMongoId().withMessage("Invalid channel ID"),
  communityController.searchMessages
);

export default router;

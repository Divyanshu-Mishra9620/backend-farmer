import * as communityService from "./communityChat.service.js";
import { validationResult } from "express-validator";

export const getChannels = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      category,
      search,
      sortBy = "lastActivity",
      order = "desc",
    } = req.query;

    const channels = await communityService.getChannels({
      page: parseInt(page),
      limit: parseInt(limit),
      category,
      search,
      sortBy,
      order,
      userId: req.user.id,
    });

    res.json({
      success: true,
      data: channels,
      message: "Channels retrieved successfully",
    });
  } catch (error) {
    console.error("Get channels error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to retrieve channels",
      error: error.message,
    });
  }
};

export const getChannel = async (req, res) => {
  try {
    const { channelId } = req.params;
    const channel = await communityService.getChannelById(
      channelId,
      req.user.id
    );

    if (!channel) {
      return res.status(404).json({
        success: false,
        message: "Channel not found",
      });
    }

    res.json({
      success: true,
      data: channel,
      message: "Channel retrieved successfully",
    });
  } catch (error) {
    console.error("Get channel error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to retrieve channel",
      error: error.message,
    });
  }
};

export const createChannel = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: errors.array(),
      });
    }

    const channelData = {
      ...req.body,
      createdBy: req.user.id,
    };

    const channel = await communityService.createChannel(channelData);

    res.status(201).json({
      success: true,
      data: channel,
      message: "Channel created successfully",
    });
  } catch (error) {
    console.error("Create channel error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create channel",
      error: error.message,
    });
  }
};

export const joinChannel = async (req, res) => {
  try {
    const { channelId } = req.params;
    const userId = req.user.id;

    const membership = await communityService.joinChannel(channelId, userId);

    res.json({
      success: true,
      data: membership,
      message: "Successfully joined channel",
    });
  } catch (error) {
    console.error("Join channel error:", error);

    if (error.message === "Channel not found") {
      return res.status(404).json({
        success: false,
        message: "Channel not found",
      });
    }

    if (error.message === "Already a member") {
      return res.status(400).json({
        success: false,
        message: "You are already a member of this channel",
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to join channel",
      error: error.message,
    });
  }
};

export const leaveChannel = async (req, res) => {
  try {
    const { channelId } = req.params;
    const userId = req.user.id;

    await communityService.leaveChannel(channelId, userId);

    res.json({
      success: true,
      message: "Successfully left channel",
    });
  } catch (error) {
    console.error("Leave channel error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to leave channel",
      error: error.message,
    });
  }
};

export const getChannelMessages = async (req, res) => {
  try {
    const { channelId } = req.params;
    const { page = 1, limit = 50, before, after } = req.query;

    const isMember = await communityService.isChannelMember(
      channelId,
      req.user.id
    );
    if (!isMember) {
      return res.status(403).json({
        success: false,
        message: "You must be a member to view channel messages",
      });
    }

    const messages = await communityService.getChannelMessages({
      channelId,
      page: parseInt(page),
      limit: parseInt(limit),
      before,
      after,
    });

    res.json({
      success: true,
      data: messages,
      message: "Messages retrieved successfully",
    });
  } catch (error) {
    console.error("Get messages error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to retrieve messages",
      error: error.message,
    });
  }
};

export const sendMessage = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: errors.array(),
      });
    }

    const { channelId } = req.params;
    const messageData = {
      ...req.body,
      channelId,
      userId: req.user.id,
    };

    const isMember = await communityService.isChannelMember(
      channelId,
      req.user.id
    );
    if (!isMember) {
      return res.status(403).json({
        success: false,
        message: "You must be a member to send messages",
      });
    }

    const message = await communityService.sendMessage(messageData);

    req.app.get("io").to(`channel:${channelId}`).emit("new_message", {
      message,
      channelId,
    });

    res.status(201).json({
      success: true,
      data: message,
      message: "Message sent successfully",
    });
  } catch (error) {
    console.error("Send message error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to send message",
      error: error.message,
    });
  }
};

export const addReaction = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { emoji } = req.body;
    const userId = req.user.id;

    const message = await communityService.addReaction(
      messageId,
      userId,
      emoji
    );

    const channelId = message.channelId;
    req.app.get("io").to(`channel:${channelId}`).emit("message_reaction", {
      messageId,
      userId,
      emoji,
      action: "add",
    });

    res.json({
      success: true,
      data: message,
      message: "Reaction added successfully",
    });
  } catch (error) {
    console.error("Add reaction error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to add reaction",
      error: error.message,
    });
  }
};

export const removeReaction = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { emoji } = req.body;
    const userId = req.user.id;

    const message = await communityService.removeReaction(
      messageId,
      userId,
      emoji
    );

    const channelId = message.channelId;
    req.app.get("io").to(`channel:${channelId}`).emit("message_reaction", {
      messageId,
      userId,
      emoji,
      action: "remove",
    });

    res.json({
      success: true,
      data: message,
      message: "Reaction removed successfully",
    });
  } catch (error) {
    console.error("Remove reaction error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to remove reaction",
      error: error.message,
    });
  }
};

export const getUserChannels = async (req, res) => {
  try {
    const userId = req.user.id;
    const channels = await communityService.getUserChannels(userId);

    res.json({
      success: true,
      data: channels,
      message: "User channels retrieved successfully",
    });
  } catch (error) {
    console.error("Get user channels error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to retrieve user channels",
      error: error.message,
    });
  }
};

export const getChannelMembers = async (req, res) => {
  try {
    const { channelId } = req.params;
    const { page = 1, limit = 50, search, role } = req.query;

    const isMember = await communityService.isChannelMember(
      channelId,
      req.user.id
    );
    if (!isMember) {
      return res.status(403).json({
        success: false,
        message: "You must be a member to view channel members",
      });
    }

    const members = await communityService.getChannelMembers({
      channelId,
      page: parseInt(page),
      limit: parseInt(limit),
      search,
      role,
    });

    res.json({
      success: true,
      data: members,
      message: "Channel members retrieved successfully",
    });
  } catch (error) {
    console.error("Get channel members error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to retrieve channel members",
      error: error.message,
    });
  }
};

export const updateChannel = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: errors.array(),
      });
    }

    const { channelId } = req.params;
    const userId = req.user.id;

    const canModerate = await communityService.canModerateChannel(
      channelId,
      userId
    );
    if (!canModerate) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to modify this channel",
      });
    }

    const updatedChannel = await communityService.updateChannel(
      channelId,
      req.body
    );

    res.json({
      success: true,
      data: updatedChannel,
      message: "Channel updated successfully",
    });
  } catch (error) {
    console.error("Update channel error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update channel",
      error: error.message,
    });
  }
};

export const deleteMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.user.id;

    const result = await communityService.deleteMessage(messageId, userId);

    req.app
      .get("io")
      .to(`channel:${result.channelId}`)
      .emit("message_deleted", {
        messageId,
        deletedBy: userId,
      });

    res.json({
      success: true,
      message: "Message deleted successfully",
    });
  } catch (error) {
    console.error("Delete message error:", error);

    if (error.message === "Message not found") {
      return res.status(404).json({
        success: false,
        message: "Message not found",
      });
    }

    if (error.message === "Unauthorized") {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to delete this message",
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to delete message",
      error: error.message,
    });
  }
};

export const togglePin = async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.user.id;

    const message = await communityService.toggleMessagePin(messageId, userId);

    req.app.get("io").to(`channel:${message.channelId}`).emit("message_pin_toggled", {
      messageId,
      isPinned: message.isPinned,
    });

    res.json({
      success: true,
      data: message,
      message: message.isPinned ? "Message pinned" : "Message unpinned",
    });
  } catch (error) {
    console.error("Toggle pin error:", error);

    if (error.message === "Message not found") {
      return res.status(404).json({ success: false, message: "Message not found" });
    }
    if (error.message === "Unauthorized") {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to pin messages in this channel",
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to toggle pin",
      error: error.message,
    });
  }
};

export const getPinnedMessages = async (req, res) => {
  try {
    const { channelId } = req.params;
    const pinnedMessages = await communityService.getPinnedMessages(
      channelId,
      req.user.id
    );

    res.json({
      success: true,
      data: pinnedMessages,
      message: "Pinned messages retrieved successfully",
    });
  } catch (error) {
    console.error("Get pinned messages error:", error);

    if (error.message === "Access denied") {
      return res.status(403).json({
        success: false,
        message: "You must be a member to view pinned messages",
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to retrieve pinned messages",
      error: error.message,
    });
  }
};

export const searchMessages = async (req, res) => {
  try {
    const { query, channelId, page = 1, limit = 20 } = req.query;

    if (!query || !query.trim()) {
      return res.status(400).json({
        success: false,
        message: "Search query is required",
      });
    }

    const results = await communityService.searchMessages(query, req.user.id, {
      channelId,
      page: parseInt(page),
      limit: parseInt(limit),
    });

    res.json({
      success: true,
      data: results,
      message: "Search completed successfully",
    });
  } catch (error) {
    console.error("Search messages error:", error);

    if (error.message === "Access denied") {
      return res.status(403).json({
        success: false,
        message: "You must be a member of that channel to search its messages",
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to search messages",
      error: error.message,
    });
  }
};

export const getChannelAnalytics = async (req, res) => {
  try {
    const { channelId } = req.params;
    const { days = 7 } = req.query;

    const analytics = await communityService.getChannelAnalytics(
      channelId,
      req.user.id,
      parseInt(days)
    );

    res.json({
      success: true,
      data: analytics,
      message: "Channel analytics retrieved successfully",
    });
  } catch (error) {
    console.error("Get channel analytics error:", error);

    if (error.message === "Unauthorized") {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to view this channel's analytics",
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to retrieve channel analytics",
      error: error.message,
    });
  }
};

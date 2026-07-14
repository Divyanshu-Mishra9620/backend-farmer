import * as communityService from "./communityChat.service.js";
import httpError from "../../shared/utils/httpError.js";

export const getChannels = async (req, res, next) => {
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
    next(error);
  }
};

export const getChannel = async (req, res, next) => {
  try {
    const { channelId } = req.params;
    const channel = await communityService.getChannelById(
      channelId,
      req.user.id
    );

    if (!channel) {
      throw httpError(404, "Channel not found");
    }

    res.json({
      success: true,
      data: channel,
      message: "Channel retrieved successfully",
    });
  } catch (error) {
    next(error);
  }
};

export const createChannel = async (req, res, next) => {
  try {
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
    next(error);
  }
};

export const joinChannel = async (req, res, next) => {
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
    next(error);
  }
};

export const leaveChannel = async (req, res, next) => {
  try {
    const { channelId } = req.params;
    const userId = req.user.id;

    await communityService.leaveChannel(channelId, userId);

    res.json({
      success: true,
      message: "Successfully left channel",
    });
  } catch (error) {
    next(error);
  }
};

export const getChannelMessages = async (req, res, next) => {
  try {
    const { channelId } = req.params;
    const { page = 1, limit = 50, before, after } = req.query;

    const isMember = await communityService.isChannelMember(
      channelId,
      req.user.id
    );
    if (!isMember) {
      throw httpError(403, "You must be a member to view channel messages");
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
    next(error);
  }
};

export const sendMessage = async (req, res, next) => {
  try {
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
      throw httpError(403, "You must be a member to send messages");
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
    next(error);
  }
};

export const uploadAttachment = async (req, res, next) => {
  try {
    const { channelId } = req.params;
    const userId = req.user.id;

    const isMember = await communityService.isChannelMember(channelId, userId);
    if (!isMember) {
      throw httpError(403, "You must be a channel member to upload attachments");
    }

    if (!req.file) {
      throw httpError(400, "No file uploaded");
    }

    const url = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;

    res.json({
      success: true,
      data: {
        type: "image",
        url,
        filename: req.file.originalname,
        size: req.file.size,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const addReaction = async (req, res, next) => {
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
    next(error);
  }
};

export const removeReaction = async (req, res, next) => {
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
    next(error);
  }
};

export const getUserChannels = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const channels = await communityService.getUserChannels(userId);

    res.json({
      success: true,
      data: channels,
      message: "User channels retrieved successfully",
    });
  } catch (error) {
    next(error);
  }
};

export const getChannelMembers = async (req, res, next) => {
  try {
    const { channelId } = req.params;
    const { page = 1, limit = 50, search, role } = req.query;

    const isMember = await communityService.isChannelMember(
      channelId,
      req.user.id
    );
    if (!isMember) {
      throw httpError(403, "You must be a member to view channel members");
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
    next(error);
  }
};

export const updateChannel = async (req, res, next) => {
  try {
    const { channelId } = req.params;
    const userId = req.user.id;

    const canModerate = await communityService.canModerateChannel(
      channelId,
      userId
    );
    if (!canModerate) {
      throw httpError(403, "You do not have permission to modify this channel");
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
    next(error);
  }
};

export const deleteChannel = async (req, res, next) => {
  try {
    const { channelId } = req.params;
    const userId = req.user.id;

    await communityService.deleteChannel(channelId, userId);

    req.app.get("io").to(`channel:${channelId}`).emit("channel_deleted", {
      channelId,
    });

    res.json({
      success: true,
      message: "Channel deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};

export const deleteMessage = async (req, res, next) => {
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
    next(error);
  }
};

export const togglePin = async (req, res, next) => {
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
    next(error);
  }
};

export const getPinnedMessages = async (req, res, next) => {
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
    next(error);
  }
};

export const searchMessages = async (req, res, next) => {
  try {
    const { query, channelId, page = 1, limit = 20 } = req.query;

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
    next(error);
  }
};

export const getChannelAnalytics = async (req, res, next) => {
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
    next(error);
  }
};

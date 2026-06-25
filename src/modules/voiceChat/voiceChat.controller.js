import {
  createVoiceSession,
  processAudioData,
  terminateSession,
  getUserVoiceHistory,
} from "./voiceChat.service.js";

export const startVoiceSession = async (req, res) => {
  try {
    const userId = req?.user?.id;
    const language = req?.body?.language || "hindi";

    const session = await createVoiceSession(userId, language);

    res.json({
      success: true,
      message: "Voice session started successfully",
      data: session,
    });
  } catch (error) {
    console.error("Error starting voice session:", error);
    res.status(500).json({
      success: false,
      message: "Failed to start voice session",
      error: error.message,
    });
  }
};

export const processVoiceQuery = async (req, res) => {
  try {
    const userId = req?.user?.id;

    console.log("[Voice] Request body:", req?.body);
    console.log("[Voice] Request file:", req?.file ? "Present" : "Not present");

    if (!req?.file && !req?.body?.audioData) {
      return res.status(400).json({
        success: false,
        message: "Audio file or data is required",
      });
    }

    let audioData;
    const language = req?.body?.language || "hindi";
    const sessionId = req?.body?.sessionId;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: "Session ID is required",
      });
    }

    if (req?.file) {
      audioData = req?.file?.buffer?.toString("base64");
      console.log(
        `[Voice] Received audio file: ${req?.file?.size} bytes, mimetype: ${req?.file?.mimetype}`
      );
    } else if (req?.body?.audioData) {
      audioData = req?.body?.audioData;
      console.log(
        `[Voice] Received base64 audio data: ${audioData.length} chars`
      );
    } else {
      return res.status(400).json({
        success: false,
        message: "No audio data received",
      });
    }

    const audioBuffer = Buffer.from(audioData, "base64");
    if (audioBuffer.length < 1000) {
      return res.status(400).json({
        success: false,
        message: "Audio too short",
        error: "Recording too short. Please speak for at least 1 second.",
      });
    }

    console.log(
      `[Voice] Processing audio: ${audioBuffer.length} bytes for session: ${sessionId}`
    );

    const mimetype = req?.file?.mimetype || "audio/webm";

    const result = await processAudioData(
      userId,
      sessionId,
      audioData,
      language,
      mimetype
    );

    res.json({
      success: true,
      message: "Voice query processed successfully",
      data: result,
    });
  } catch (error) {
    console.error("[Voice] Error processing voice query:", error);
    res.status(500).json({
      success: false,
      message: "Failed to process voice query",
      error: error.message,
    });
  }
};

export const endVoiceSession = async (req, res) => {
  try {
    const userId = req?.user?.id;

    const sessionId = req?.body?.sessionId;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: "Session ID is required",
      });
    }

    await terminateSession(userId, sessionId);

    res.json({
      success: true,
      message: "Voice session ended successfully",
    });
  } catch (error) {
    console.error("Error ending voice session:", error);
    res.status(500).json({
      success: false,
      message: "Failed to end voice session",
      error: error.message,
    });
  }
};

export const getVoiceChatHistory = async (req, res) => {
  try {
    const userId = req?.user?.id;
    const { page = 1, limit = 10 } = req?.query;

    const history = await getUserVoiceHistory(
      userId,
      parseInt(page),
      parseInt(limit)
    );

    res.json({
      success: true,
      message: "Voice chat history retrieved successfully",
      data: history,
    });
  } catch (error) {
    console.error("Error getting voice chat history:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get voice chat history",
      error: error.message,
    });
  }
};

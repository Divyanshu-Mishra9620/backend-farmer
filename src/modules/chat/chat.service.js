import config from "../../config/env.js";
import { executeFarmerAssistantPipeline } from "./langraph.pipeline.js";
import { Conversation, Analytics, UserPreferences } from "./chat.models.js";
import mongoose from "mongoose";

export async function converseWithAssistant({
  messages,
  context = {},
  userId = null,
  conversationId = null,
}) {
  const startTime = Date.now();

  try {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error("Messages array is required and cannot be empty");
    }

    let userPreferences = null;
    if (userId) {
      try {
        userPreferences = await UserPreferences.findOne({ userId });
      } catch (prefError) {
        console.error("Error loading user preferences:", prefError);
      }
    }

    const enrichedContext = await enrichContextWithUserData(
      context,
      userId,
      conversationId
    );

    if (!config.groqApiKey && !config.geminiApiKey) {
      console.warn("No AI API keys configured, using fallback response");
      return generateFallbackResponse(
        messages,
        enrichedContext,
        userPreferences
      );
    }

    const result = await executeFarmerAssistantPipeline(
      messages,
      enrichedContext
    );

    if (userPreferences) {
      result.replies = personalizeResponses(result.replies, userPreferences);
    }

    const responseTime = Date.now() - startTime;

    if (userId) {
      await trackConversationAnalytics(
        userId,
        messages,
        enrichedContext,
        result,
        responseTime,
        true
      );
    }

    console.log("Pipeline executed successfully:", {
      userId,
      messageCount: messages.length,
      hasContext: Object.keys(enrichedContext).length > 0,
      responseTime,
      responseLength: result.replies?.[0]?.content?.length || 0,
    });

    return {
      ...result,
      responseTime,
      userId,
      conversationId,
      userPreferences: userPreferences ? userPreferences.toObject() : null,
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    console.error("LangGraph pipeline failed:", error);

    if (userId) {
      await trackConversationAnalytics(
        userId,
        messages,
        context,
        null,
        responseTime,
        false,
        error.message
      );
    }

    return generateFallbackResponse(messages, context, null, error);
  }
}

async function enrichContextWithUserData(context, userId, conversationId) {
  const enrichedContext = { ...context };

  if (!userId) return enrichedContext;

  try {
    const userPrefs = await UserPreferences.findOne({ userId });
    if (userPrefs) {
      enrichedContext.userProfile = {
        farmingType: userPrefs.farmingType,
        primaryCrops: userPrefs.primaryCrops,
        location: userPrefs.location,
        experienceLevel: userPrefs.experienceLevel,
        farmSize: userPrefs.farmSize,
        language: userPrefs.language,
      };
    }

    const recentConversations = await Conversation.find({ userId })
      .sort({ lastActivity: -1 })
      .limit(3)
      .select("context messages");

    if (recentConversations.length > 0) {
      const recentTopics = extractTopicsFromConversations(recentConversations);
      const commonContext = mergeCommonContext(recentConversations);

      enrichedContext.conversationHistory = {
        recentTopics,
        commonContext,
        conversationCount: recentConversations.length,
      };
    }

    const currentMonth = new Date().getMonth() + 1;
    const seasonalContext = getSeasonalContext(
      currentMonth,
      enrichedContext.userProfile?.location?.state
    );
    if (seasonalContext) {
      enrichedContext.seasonal = seasonalContext;
    }
  } catch (error) {
    console.error("Error enriching context:", error);
  }

  return enrichedContext;
}

function personalizeResponses(replies, userPreferences) {
  if (!replies || !userPreferences) return replies;

  return replies.map((reply) => {
    let content = reply.content;

    if (userPreferences.experienceLevel === "beginner") {
      content = simplifyLanguageForBeginners(content);
    }

    if (userPreferences.farmSize) {
      content = adjustForFarmSize(content, userPreferences.farmSize);
    }

    if (userPreferences.location?.state) {
      content = addLocationSpecificAdvice(content, userPreferences.location);
    }

    return {
      ...reply,
      content,
    };
  });
}

function generateFallbackResponse(
  messages,
  context,
  userPreferences = null,
  error = null
) {
  const lastMessage = messages[messages.length - 1];
  const query = lastMessage?.content?.toLowerCase() || "";

  let response = "🌾 I'm your farming assistant! ";

  if (userPreferences) {
    if (userPreferences.primaryCrops?.length > 0) {
      response += `I see you grow ${userPreferences.primaryCrops.join(", ")}. `;
    }

    if (userPreferences.location?.state) {
      response += `For farming in ${userPreferences.location.state}, `;
    }
  }

  if (context.crop) {
    response += `I see you're working with ${context.crop}. `;
  }

  if (context.coords) {
    response += `For your location in ${context.coords.formatted}, `;
  }

  if (context.weather) {
    const temp = Math.round(context.weather.temp);
    response += `with current temperature ${temp}°C and ${context.weather.humidity}% humidity, `;
  }

  const currentMonth = new Date().getMonth() + 1;
  const seasonalAdvice = getSeasonalAdvice(
    currentMonth,
    context.userProfile?.location?.state
  );
  if (seasonalAdvice) {
    response += seasonalAdvice + " ";
  }

  if (
    query.includes("pest") ||
    query.includes("insect") ||
    query.includes("bug")
  ) {
    response +=
      "for pest management, I recommend integrated pest management (IPM): ";
    response +=
      "1) Regular crop inspection 2) Use neem oil spray 3) Introduce beneficial insects 4) Maintain crop rotation. ";

    if (userPreferences?.farmingType === "organic") {
      response +=
        "Since you prefer organic farming, focus on neem-based solutions and companion planting.";
    }
  } else if (query.includes("market") || query.includes("price")) {
    response += "for current market information: ";
    response +=
      "1) Check local mandi prices 2) Consider direct selling 3) Join farmer producer organizations 4) Time your harvest strategically.";

    if (context.market) {
      response += ` Current top crops in your area: ${context.market.top?.join(", ") || "wheat, rice, pulses"}.`;
    }
  } else {
    response +=
      "I can help with crop selection, pest management, disease control, fertilization, irrigation, and marketing. ";
    response += "What specific farming challenge are you facing?";
  }

  if (context.weather) {
    const weatherAdvice = getWeatherBasedAdvice(context.weather);
    if (weatherAdvice) {
      response += "\n\n" + weatherAdvice;
    }
  }

  response +=
    "\n\n💡 Feel free to ask more specific questions about your farming needs!";

  if (error && process.env.NODE_ENV === "development") {
    response += `\n\n🔧 (System note: ${error.message})`;
  }

  return {
    replies: [
      {
        role: "assistant",
        content: response,
      },
    ],
    fallback: true,
    userPreferences: userPreferences ? userPreferences.toObject() : null,
  };
}

async function trackConversationAnalytics(
  userId,
  messages,
  context,
  result,
  responseTime,
  success,
  error = null
) {
  try {
    const analytics = new Analytics({
      userId,
      eventType: "chat_message",
      eventData: {
        messageCount: messages.length,
        hasContext: Object.keys(context).length > 0,
        contextTypes: Object.keys(context),
        responseTime,
        success,
        error,
        hasUserProfile: !!context.userProfile,
        hasConversationHistory: !!context.conversationHistory,
      },
      responseTime,
      success,
      errorMessage: error,
    });

    await analytics.save();
  } catch (error) {
    console.error("Failed to track conversation analytics:", error);
  }
}

function extractTopicsFromConversations(conversations) {
  const topics = new Set();

  conversations.forEach((conv) => {
    conv.messages.forEach((msg) => {
      if (msg.role === "user") {
        const content = msg?.content?.toLowerCase();
        if (content.includes("pest")) topics.add("pest_management");
        if (content.includes("crop")) topics.add("crop_selection");
        if (content.includes("soil")) topics.add("soil_health");
        if (content.includes("weather")) topics.add("weather");
        if (content.includes("market")) topics.add("market_prices");
      }
    });
  });

  return Array.from(topics);
}

function mergeCommonContext(conversations) {
  const commonContext = {};

  conversations.forEach((conv) => {
    if (conv.context) {
      Object.keys(conv.context).forEach((key) => {
        if (!commonContext[key] && conv.context[key]) {
          commonContext[key] = conv.context[key];
        }
      });
    }
  });

  return commonContext;
}

function getSeasonalContext(month, state) {
  const seasons = {
    kharif: [6, 7, 8, 9],
    rabi: [10, 11, 12, 1, 2, 3],
    summer: [4, 5],
  };

  let currentSeason = "summer";
  if (seasons.kharif.includes(month)) currentSeason = "kharif";
  if (seasons.rabi.includes(month)) currentSeason = "rabi";

  return {
    season: currentSeason,
    month,
    recommendedCrops: getSeasonalCrops(currentSeason, state),
  };
}

function getSeasonalCrops(season, state) {
  const crops = {
    kharif: ["Rice", "Cotton", "Sugarcane", "Maize", "Sorghum"],
    rabi: ["Wheat", "Barley", "Peas", "Gram", "Mustard"],
    summer: ["Fodder crops", "Vegetables", "Fruits"],
  };

  return crops[season] || [];
}

function getSeasonalAdvice(month, state) {
  const currentSeason = getSeasonalContext(month, state);

  const advice = {
    kharif:
      "it's kharif season - good time for rice, cotton, and maize cultivation",
    rabi: "it's rabi season - ideal for wheat, gram, and mustard crops",
    summer:
      "it's summer season - focus on irrigation management and heat-resistant varieties",
  };

  return advice[currentSeason.season];
}

function getWeatherBasedAdvice(weather) {
  let advice = [];

  if (weather.temp > 35) {
    advice.push(
      "🌡️ High temperature alert: Increase watering frequency and provide shade protection"
    );
  }

  if (weather.humidity > 80) {
    advice.push(
      "💧 High humidity: Watch for fungal diseases and ensure good ventilation"
    );
  }

  if (weather.rain > 10) {
    advice.push(
      "☔ Heavy rain expected: Ensure proper drainage and avoid field operations"
    );
  }

  return advice.length > 0 ? advice.join(". ") : null;
}

function simplifyLanguageForBeginners(content) {
  return content
    .replace(
      /integrated pest management \(IPM\)/gi,
      "natural pest control methods"
    )
    .replace(/vermicompost/gi, "worm compost")
    .replace(/foliar application/gi, "spraying on leaves")
    .replace(/nitrogen deficiency/gi, "lack of nutrients for green growth")
    .replace(/soil pH/gi, "soil acidity level")
    .replace(/crop rotation/gi, "changing crops each season");
}

function adjustForFarmSize(content, farmSize) {
  if (farmSize.value < 2 && farmSize.unit === "acres") {
    content +=
      "\n\n🏡 For small farms like yours, focus on high-value crops and intensive farming methods.";
  } else if (farmSize.value > 10) {
    content +=
      "\n\n🚜 For larger farms, consider mechanization and bulk purchasing of inputs for cost efficiency.";
  }

  return content;
}

function addLocationSpecificAdvice(content, location) {
  const stateAdvice = {
    Punjab:
      "Consider water-efficient crops due to declining groundwater levels.",
    Maharashtra: "Dryland farming techniques are beneficial in many regions.",
    "Tamil Nadu": "Rice cultivation and water management are key focus areas.",
    Karnataka: "Mixed farming with millets is gaining popularity.",
    "Uttar Pradesh":
      "Wheat-rice rotation is common, but diversification is recommended.",
    Rajasthan:
      "Desert farming and water conservation techniques are essential.",
    "West Bengal": "Rice cultivation and fish farming integration works well.",
    Gujarat:
      "Cotton and groundnut are major crops, consider soil health management.",
  };

  if (stateAdvice[location.state]) {
    content += `\n\n📍 Specific to ${location.state}: ${stateAdvice[location.state]}`;
  }

  return content;
}

export async function getConversationHistory(userId, limit = 10) {
  try {
    const conversations = await Conversation.find({ userId })
      .sort({ lastActivity: -1 })
      .limit(limit)
      .select("sessionId context messages createdAt lastActivity")
      .lean();

    return conversations;
  } catch (error) {
    console.error("Error fetching conversation history:", error);
    return [];
  }
}

export async function saveConversation(
  userId,
  sessionId,
  messages,
  context = {}
) {
  try {
    let conversation = await Conversation.findOne({ userId, sessionId });

    if (!conversation) {
      conversation = new Conversation({
        userId,
        sessionId,
        messages: [],
        context,
      });
    }

    const existingMessageCount = conversation.messages.length;
    const newMessages = messages.slice(existingMessageCount);

    if (newMessages.length > 0) {
      conversation.messages.push(...newMessages);
      conversation.context = { ...conversation.context, ...context };
      conversation.lastActivity = new Date();

      await conversation.save();
    }

    return conversation;
  } catch (error) {
    console.error("Error saving conversation:", error);
    throw error;
  }
}

export async function cleanupOldConversations(daysOld = 90) {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await Conversation.deleteMany({
      lastActivity: { $lt: cutoffDate },
    });

    console.log(`Cleaned up ${result.deletedCount} old conversations`);
    return result.deletedCount;
  } catch (error) {
    console.error("Error cleaning up conversations:", error);
    throw error;
  }
}

export async function getUserAnalytics(userId, days = 30) {
  try {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const analytics = await Analytics.aggregate([
      {
        $match: {
          userId: new mongoose.Types.ObjectId(userId),
          createdAt: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: "$eventType",
          count: { $sum: 1 },
          avgResponseTime: { $avg: "$responseTime" },
          successRate: {
            $avg: { $cond: ["$success", 1, 0] },
          },
        },
      },
    ]);

    return analytics;
  } catch (error) {
    console.error("Error fetching user analytics:", error);
    return [];
  }
}

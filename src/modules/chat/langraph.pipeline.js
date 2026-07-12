import { StateGraph, END } from "@langchain/langgraph";
import { ChatGroq } from "@langchain/groq";
import { GoogleGenerativeAI } from "@google/generative-ai";
import config from "../../config/env.js";
import { createLogger } from "../../shared/utils/logger.js";
import { aiCache, LRUCache } from "../../shared/utils/cache.js";
import { safeErrorMessage } from "../../shared/utils/safeError.js";

const logger = createLogger("LangGraph");

let groq = null;
let genAI = null;
let geminiModel = null;

const initializeLLMs = () => {
  if (!groq && config.groqApiKey) {
    groq = new ChatGroq({
      apiKey: config.groqApiKey,
      model: "llama-3.3-70b-versatile",
    });
  }

  if (!genAI && config.geminiApiKey) {
    genAI = new GoogleGenerativeAI(config.geminiApiKey);
    geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  }

  if (!groq || !genAI) {
    logger.warn(
      "⚠️  LLM APIs not fully initialized. Missing API keys. App will attempt fallback mode.",
    );
  }
};

// Initialize on first use
initializeLLMs();

const AgentState = {
  messages: {
    value: (x, y) => {
      const xArray = Array.isArray(x) ? x : [];
      const yArray = Array.isArray(y) ? y : [];
      return xArray.concat(yArray);
    },
    default: () => [],
  },
  context: {
    value: (x, y) => {
      const xObj = x && typeof x === "object" ? x : {};
      const yObj = y && typeof y === "object" ? y : {};
      return { ...xObj, ...yObj };
    },
    default: () => ({}),
  },
  analysis: {
    value: (x, y) => {
      const xObj = x && typeof x === "object" ? x : {};
      const yObj = y && typeof y === "object" ? y : {};
      return { ...xObj, ...yObj };
    },
    default: () => ({}),
  },
  recommendations: {
    value: (x, y) => {
      const xArray = Array.isArray(x) ? x : [];
      const yArray = Array.isArray(y) ? y : [];
      return xArray.concat(yArray);
    },
    default: () => [],
  },
  currentStep: {
    value: (x, y) => y || x || "analyze_context",
    default: () => "analyze_context",
  },
  finalResponse: {
    value: (x, y) => y || x || "",
    default: () => "",
  },
};

function safeExtractContext(context) {
  const safeContext = context || {};
  return {
    crop: safeContext.crop || null,
    location: safeContext.location
      ? {
          address: safeContext.location.address || null,
          coordinates: safeContext.location.coordinates || null,
          state: safeContext.location.state || null,
          district: safeContext.location.district || null,
        }
      : null,
    weather: safeContext.weather
      ? {
          temp: safeContext.weather.temp,
          humidity: safeContext.weather.humidity,
          rain: safeContext.weather.rain,
          description: safeContext.weather.description,
        }
      : null,
    soilAnalysis: safeContext.soilAnalysis || null,
    marketData: safeContext.marketData || null,
  };
}

async function analyzeContext(state) {
  const { context = {}, messages = [] } = state;
  const lastMessage =
    messages.length > 0 ? messages[messages.length - 1]?.content || "" : "";

  const safeContext = safeExtractContext(context);

  const analysisPrompt = `
You are an expert agricultural AI assistant for Indian farmers. Analyze the farmer's query and context:

Query: "${lastMessage}"
Context: ${JSON.stringify(safeContext, null, 2)}

Determine:
1. Type of query (crop selection, pest management, weather advice, market info, soil health, general farming)
2. Urgency level (high/medium/low)
3. Required information sources
4. Specific recommendations needed

Respond in JSON format:
{
  "queryType": "...",
  "urgency": "...",
  "requiredSources": ["weather", "soil", "market", "crop_data"],
  "specificNeeds": ["..."]
}
  `;

  try {
    if (!groq) {
      logger.warn("Groq LLM not initialized, using fallback analysis");
      return {
        ...state,
        analysis: getFallbackAnalysis(),
        currentStep: "generate_recommendations",
      };
    }

    const result = await groq.invoke([
      { role: "user", content: analysisPrompt },
    ]);

    let analysis;
    try {
      analysis = JSON.parse(result.content);
    } catch {
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          analysis = JSON.parse(jsonMatch[0]);
        } catch {
          analysis = getFallbackAnalysis();
        }
      } else {
        analysis = getFallbackAnalysis();
      }
    }

    return {
      ...state,
      analysis,
      currentStep: "generate_recommendations",
    };
  } catch (error_) {
    logger.warn("Context analysis failed, using fallback", error_.message);
    return {
      ...state,
      analysis: getFallbackAnalysis(),
      currentStep: "generate_recommendations",
    };
  }
}

async function generateRecommendations(state) {
  const { context = {}, messages = [], analysis = {} } = state;
  const lastMessage =
    messages.length > 0 ? messages[messages.length - 1]?.content || "" : "";

  const safeContext = safeExtractContext(context);

  const formatContextForPrompt = (ctx) => {
    let contextStr = "";
    if (ctx.crop) contextStr += `- Crop: ${ctx.crop}\n`;
    if (ctx.location) {
      if (ctx.location.address)
        contextStr += `- Location: ${ctx.location.address}\n`;
      if (ctx.location.state) contextStr += `- State: ${ctx.location.state}\n`;
    }
    if (ctx.weather) {
      contextStr += `- Weather: ${ctx.weather.temp ? `${Math.round(ctx.weather.temp)}°C` : "N/A"}, ${ctx.weather.humidity || "N/A"}% humidity`;
      if (ctx.weather.rain) contextStr += `, ${ctx.weather.rain}mm rain`;
      if (ctx.weather.description) contextStr += `, ${ctx.weather.description}`;
      contextStr += "\n";
    }
    if (ctx.soilAnalysis)
      contextStr += `- Soil Analysis: ${ctx.soilAnalysis.summary || "Analysis available"}\n`;
    if (ctx.marketData)
      contextStr += `- Market Data: Current price ₹${ctx.marketData.currentPrice || "N/A"}/kg\n`;
    return contextStr || "No specific context provided";
  };

  const farmingPrompt = `
You are an expert agricultural advisor for Indian farmers. Provide comprehensive, practical advice.

Farmer's Query: "${lastMessage}"
Query Analysis: ${JSON.stringify(analysis)}
Context Information:
${formatContextForPrompt(safeContext)}

Guidelines:
1. Be practical and actionable
2. Consider local Indian farming conditions
3. Provide specific steps the farmer can take
4. Include timing recommendations when relevant
5. Mention cost-effective solutions
6. Use simple, clear language

Respond in a conversational, helpful manner. Keep your response comprehensive but easy to understand.
  `;

  try {
    if (!geminiModel) {
      logger.warn(
        "Gemini Model not initialized, using fallback recommendations",
      );
      const fallbackResponse = generateFallbackResponse(
        lastMessage,
        safeContext,
      );
      return {
        ...state,
        recommendations: [fallbackResponse],
        currentStep: "format_response",
      };
    }

    const result = await geminiModel.generateContent(farmingPrompt);
    const recommendation = result.response.text();

    return {
      ...state,
      recommendations: [recommendation],
      currentStep: "format_response",
    };
  } catch (error_) {
    logger.error("Gemini recommendation generation failed", error_.message);
    const fallbackResponse = generateFallbackResponse(lastMessage, safeContext);
    return {
      ...state,
      recommendations: [fallbackResponse],
      currentStep: "format_response",
    };
  }
}

async function formatResponse(state) {
  const { recommendations = [], context = {} } = state;
  const mainRecommendation =
    recommendations.length > 0
      ? recommendations[0]
      : "I'm here to help with your farming questions!";

  const safeContext = safeExtractContext(context);
  let additionalTips = [];

  if (safeContext.weather) {
    if (safeContext.weather.temp > 35) {
      additionalTips.push(
        "🌡️ High temperature alert: Consider evening watering and shade protection.",
      );
    }
    if (safeContext.weather.humidity > 80) {
      additionalTips.push(
        "💧 High humidity: Monitor for fungal diseases and ensure good air circulation.",
      );
    }
    if (safeContext.weather.rain > 0) {
      additionalTips.push(
        "☔ Rain detected: Adjust irrigation schedule accordingly.",
      );
    }
  }

  if (safeContext.crop) {
    additionalTips.push(
      `🌱 For ${safeContext.crop}: Check crop-specific guides for detailed care.`,
    );
  }

  let finalResponse = mainRecommendation;
  if (additionalTips.length > 0) {
    finalResponse += "\n\n**Additional Tips:**\n" + additionalTips.join("\n");
  }
  finalResponse +=
    "\n\n💡 **Need more help?** Feel free to ask about specific crops, pest problems, soil issues, or market prices!";

  return {
    ...state,
    currentStep: "complete",
    finalResponse,
  };
}

function generateFallbackResponse(query, safeContext) {
  const responses = {
    crop: `For crop selection, consider your local climate and soil conditions. ${safeContext.location?.address ? `In your area (${safeContext.location.address}), ` : ""}popular options include wheat, rice, and pulses. Consider water availability, market demand, and your farming experience.`,
    pest: "For pest management, start with integrated pest management (IPM): 1) Regular crop monitoring, 2) Use of beneficial insects, 3) Organic pesticides like neem oil, 4) Crop rotation. Always identify the pest correctly before treatment.",
    soil: "For soil health: 1) Regular soil testing, 2) Add organic compost, 3) Practice crop rotation, 4) Use cover crops, 5) Minimize tillage. Healthy soil is the foundation of successful farming.",
    weather: `${safeContext.weather ? `Current conditions: ${Math.round(safeContext.weather.temp)}°C, ${safeContext.weather.humidity}% humidity. ` : ""}Plan your farming activities based on weather forecasts.`,
    market:
      "For market information, research local wholesale prices, connect with farmer producer organizations (FPOs), and explore direct marketing opportunities.",
    default:
      "I'm here to help with all your farming questions! Ask about crop selection, pest management, soil health, weather planning, or market prices.",
  };

  const queryLower = query?.toLowerCase() || "";
  if (
    queryLower.includes("crop") ||
    queryLower.includes("plant") ||
    queryLower.includes("grow")
  )
    return responses.crop;
  if (
    queryLower.includes("pest") ||
    queryLower.includes("insect") ||
    queryLower.includes("disease")
  )
    return responses.pest;
  if (queryLower.includes("soil") || queryLower.includes("fertilizer"))
    return responses.soil;
  if (queryLower.includes("weather") || queryLower.includes("rain"))
    return responses.weather;
  if (queryLower.includes("market") || queryLower.includes("price"))
    return responses.market;
  return responses.default;
}

function getFallbackAnalysis() {
  return {
    queryType: "general_farming",
    urgency: "medium",
    requiredSources: ["general"],
    specificNeeds: ["basic_advice"],
  };
}

function createFarmerAssistantWorkflow() {
  try {
    const workflow = new StateGraph({ channels: AgentState });

    workflow
      .addNode("analyze_context", analyzeContext)
      .addNode("generate_recommendations", generateRecommendations)
      .addNode("format_response", formatResponse)
      .addEdge("analyze_context", "generate_recommendations")
      .addEdge("generate_recommendations", "format_response")
      .addEdge("format_response", END)
      .setEntryPoint("analyze_context");

    return workflow.compile();
  } catch (error1) {
    try {
      const workflow = new StateGraph(AgentState);
      workflow
        .addNode("analyze_context", analyzeContext)
        .addNode("generate_recommendations", generateRecommendations)
        .addNode("format_response", formatResponse)
        .addEdge("analyze_context", "generate_recommendations")
        .addEdge("generate_recommendations", "format_response")
        .addEdge("format_response", END)
        .setEntryPoint("analyze_context");

      return workflow.compile();
    } catch (error2) {
      logger.error("Both workflow creation methods failed", {
        error1: error1.message,
        error2: error2.message,
      });
      throw error2;
    }
  }
}

export async function executeFarmerAssistantPipeline(messages, context = {}) {
  const startTime = Date.now();

  // Check cache first
  const lastMsg =
    Array.isArray(messages) && messages.length > 0
      ? messages[messages.length - 1]?.content || ""
      : "";
  const cacheKey = LRUCache.generateKey("langgraph", lastMsg, context);
  const cached = aiCache.get(cacheKey);
  if (cached) {
    logger.info(`Pipeline cache hit (${Date.now() - startTime}ms)`);
    return cached;
  }

  try {
    const workflow = createFarmerAssistantWorkflow();

    const initialState = {
      messages: Array.isArray(messages) ? messages : [],
      context: context && typeof context === "object" ? context : {},
      analysis: {},
      recommendations: [],
      currentStep: "analyze_context",
      finalResponse: "",
    };

    const result = await workflow.invoke(initialState);
    const duration = Date.now() - startTime;
    logger.info(`Pipeline completed in ${duration}ms`);

    const response = {
      replies: [
        {
          role: "assistant",
          content:
            result.finalResponse ||
            "I'm here to help with your farming questions!",
        },
      ],
      analysis: result.analysis || {},
      context: result.context || {},
    };

    // Cache the response
    aiCache.set(cacheKey, response);

    return response;
  } catch (error) {
    logger.error("LangGraph pipeline error", error.message);

    const safeContext = safeExtractContext(context);
    const fallbackResponse = generateFallbackResponse(lastMsg, safeContext);

    return {
      replies: [{ role: "assistant", content: fallbackResponse }],
      error: safeErrorMessage(error),
      fallback: true,
    };
  }
}

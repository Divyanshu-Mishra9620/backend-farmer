import config from "../../config/env.js";
import fetch from "node-fetch";
import { createLogger } from "../../shared/utils/logger.js";
import { aiCache, LRUCache } from "../../shared/utils/cache.js";
import httpError from "../../shared/utils/httpError.js";

const logger = createLogger("StreamController");

function buildFarmingPrompt(query, context) {
  let contextStr = "";
  if (context) {
    const parts = [];
    if (context.location) parts.push(`Location: ${context.location}`);
    if (context.crop) parts.push(`Crop: ${context.crop}`);
    if (context.soilType) parts.push(`Soil: ${context.soilType}`);
    if (context.season) parts.push(`Season: ${context.season}`);
    if (parts.length > 0) contextStr = `\n\nContext: ${parts.join(" | ")}`;
  }

  return `You are 'Krishi Mitra', a helpful agricultural AI assistant for Indian farmers.

Farmer's Question: ${query}${contextStr}

Instructions:
• Give a CONCISE, practical answer (3-5 short paragraphs maximum)
• Use simple language that farmers understand
• Include specific steps or recommendations
• Mention any critical warnings briefly
• If relevant, add local Indian farming practices

Keep it SHORT, CLEAR, and ACTIONABLE.`;
}

export async function streamSuggestion(req, res, _next) {
  const startTime = Date.now();

  try {
    const { query, context } = req.body;

    if (!query || typeof query !== "string") {
      return res.status(400).json({
        success: false,
        message: "Query is required and must be a string",
      });
    }

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    // Check cache — if hit, stream from cache immediately
    const cacheKey = LRUCache.generateKey("stream", query, context);
    const cached = aiCache.get(cacheKey);
    if (cached) {
      logger.info(`Stream cache hit for user ${req.user?.id || "anonymous"}`);
      res.write(`data: ${JSON.stringify({ status: "connecting" })}\n\n`);

      // Stream cached content word by word for smooth UX
      const words = cached.split(" ");
      for (let i = 0; i < words.length; i++) {
        const content = (i > 0 ? " " : "") + words[i];
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
      return;
    }

    const enhancedPrompt = buildFarmingPrompt(query, context);

    res.write(`data: ${JSON.stringify({ status: "connecting" })}\n\n`);
    if (res.flush) res.flush();

    if (!config.groqApiKey) {
      logger.error("Groq API key not configured");
      res.write(
        `data: ${JSON.stringify({ error: true, message: "API key not configured" })}\n\n`,
      );
      res.end();
      return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    let response;
    try {
      // Use Groq API for streaming suggestions (same as disease detection)
      logger.info("Attempting Groq API call for streaming suggestion...");
      response = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.groqApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "llama-3.3-70b-versatile",
            messages: [{ role: "user", content: enhancedPrompt }],
            stream: true,
            max_tokens: 600,
            temperature: 0.7,
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error("Groq API error", {
          status: response.status,
          body: errorBody.substring(0, 200),
        });
        throw new Error(`Groq API error: ${response.status}`);
      }

      logger.info("Groq API call successful, streaming response");
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      logger.error("Fetch error", fetchErr.message);
      res.write(
        `data: ${JSON.stringify({
          error: true,
          message:
            fetchErr.name === "AbortError"
              ? "Request timeout. Please try again."
              : "Connection failed. Please try again.",
        })}\n\n`,
      );
      res.end();
      return;
    }

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error("API error", {
        status: response.status,
        body: errorBody.substring(0, 200),
      });
      throw new Error(`API error: ${response.status}`);
    }

    let buffer = "";
    let fullResponse = "";

    try {
      for await (const chunk of response.body) {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim() === "") continue;

          // Handle Groq SSE format (same as OpenRouter)
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) {
                fullResponse += content;
                res.write(`data: ${JSON.stringify({ content })}\n\n`);
                if (res.flush) res.flush();
              }
            } catch {
              // Skip malformed chunks
            }
          }
        }
      }

      // Cache the full response for future identical queries
      if (fullResponse.length > 0) {
        aiCache.set(cacheKey, fullResponse);
      }

      const duration = Date.now() - startTime;
      logger.info(
        `Stream completed for user ${req.user?.id || "anonymous"} (${duration}ms, ${fullResponse.length} chars)`,
      );

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (streamErr) {
      logger.error("Stream iteration error", streamErr.message);
      res.write(
        `data: ${JSON.stringify({ error: true, message: "Stream interrupted. Please try again." })}\n\n`,
      );
      res.end();
    }
  } catch (err) {
    logger.error("Stream error", err.message);

    if (!res.headersSent) {
      res.setHeader("Content-Type", "text/event-stream");
    }

    res.write(
      `data: ${JSON.stringify({
        error: true,
        message:
          "An error occurred while generating suggestions. Please try again.",
      })}\n\n`,
    );
    res.end();
  }
}

export async function getSuggestion(req, res, next) {
  try {
    const { query, context } = req.body;

    if (!query || typeof query !== "string") {
      throw httpError(400, "Query is required and must be a string");
    }

    // Check cache
    const cacheKey = LRUCache.generateKey("direct", query, context);
    const cached = aiCache.get(cacheKey);
    if (cached) {
      logger.info("Direct suggestion cache hit");
      return res.json({
        success: true,
        suggestion: cached,
        query,
        cached: true,
        timestamp: new Date().toISOString(),
      });
    }

    if (!config.groqApiKey) {
      logger.error("Groq API key not configured");
      throw httpError(503, "The AI service is temporarily unavailable. Please try again shortly.");
    }

    const enhancedPrompt = buildFarmingPrompt(query, context);

    // Use Groq API (same as disease detection)
    logger.info("Calling Groq API for direct suggestion...");
    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.groqApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "mixtral-8x7b-32768",
          messages: [{ role: "user", content: enhancedPrompt }],
          max_tokens: 600,
          temperature: 0.7,
        }),
      },
    );

    if (!response.ok) {
      throw httpError(502, "The AI service returned an error. Please try again.");
    }

    const data = await response.json();
    const text = data.choices[0]?.message?.content || "No response generated";

    // Cache it
    aiCache.set(cacheKey, text);

    logger.info("Direct suggestion generated successfully");
    res.json({
      success: true,
      suggestion: text,
      query,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error("Direct suggestion error", err.message);
    next(err);
  }
}

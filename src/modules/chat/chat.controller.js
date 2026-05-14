import * as chatService from "./chat.service.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import config from "../../config/env.js";
import fs from "fs";
import { createLogger } from "../../shared/utils/logger.js";
import {
  aiCache,
  weatherCache,
  geoCache,
  LRUCache,
} from "../../shared/utils/cache.js";

const logger = createLogger("ChatController");
const genAI = new GoogleGenerativeAI(config.geminiApiKey);

export async function chatSuggest(req, res, next) {
  try {
    const { messages, context } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        success: false,
        message: "messages array is required and cannot be empty",
      });
    }

    const enrichedContext = {
      ...context,
      userId: req.user?.id,
      timestamp: new Date().toISOString(),
    };

    const result = await chatService.converseWithAssistant({
      messages,
      context: enrichedContext,
    });

    res.json({ success: true, ...result });
  } catch (err) {
    logger.error("Chat suggest error", err.message);
    next(err);
  }
}

export async function geocodeAddress(req, res, next) {
  try {
    const { address } = req.body;

    if (!address) {
      return res.status(400).json({
        success: false,
        message: "Address is required",
      });
    }

    // Check cache
    const cacheKey = LRUCache.generateKey("geo", address);
    const cached = geoCache.get(cacheKey);
    if (cached) {
      logger.info("Geocode cache hit", address);
      return res.json({ success: true, ...cached, cached: true });
    }

    const response = await fetch(
      `https://api.opencagedata.com/geocode/v1/json?q=${encodeURIComponent(address)}&key=${process.env.OPENCAGE_API_KEY || "demo"}&limit=1&countrycode=IN`,
    );

    if (!response.ok) {
      throw new Error("Geocoding service error");
    }

    const data = await response.json();

    if (data.results && data.results.length > 0) {
      const result = data.results[0];
      const geoData = {
        lat: result.geometry.lat,
        lon: result.geometry.lng,
        formatted: result.formatted,
        state: result.components.state,
        district: result.components.county || result.components.state_district,
        country: result.components.country,
      };

      // Cache geocode results (24 hours)
      geoCache.set(cacheKey, geoData);

      res.json({ success: true, ...geoData });
    } else {
      res.status(404).json({
        success: false,
        message: "Location not found",
      });
    }
  } catch (err) {
    logger.warn("Geocoding error, using fallback", err.message);
    res.json({
      success: true,
      lat: 28.6139,
      lon: 77.209,
      formatted: "Delhi, India",
      state: "Delhi",
      district: "New Delhi",
      country: "India",
      fallback: true,
    });
  }
}

export async function getWeather(req, res, next) {
  try {
    const { lat, lon } = req.query;

    if (!lat || !lon) {
      return res.status(400).json({
        success: false,
        message: "Latitude and longitude are required",
      });
    }

    // Check cache
    const cacheKey = LRUCache.generateKey("weather", lat, lon);
    const cached = weatherCache.get(cacheKey);
    if (cached) {
      logger.info("Weather cache hit");
      return res.json({ success: true, ...cached, cached: true });
    }

    const apiKey = process.env.OPENWEATHER_API_KEY || "demo";
    let weatherData;

    if (apiKey === "demo") {
      weatherData = {
        main: { temp: 28, humidity: 65 },
        weather: [{ description: "partly cloudy" }],
        rain: { "1h": 0 },
      };
    } else {
      const response = await fetch(
        `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric`,
      );
      if (!response.ok) throw new Error("Weather service error");
      weatherData = await response.json();
    }

    const result = {
      temp: weatherData.main.temp,
      humidity: weatherData.main.humidity,
      description: weatherData.weather[0].description,
      rain: weatherData.rain?.["1h"] || 0,
    };

    // Cache weather (10 minutes)
    weatherCache.set(cacheKey, result);

    res.json({ success: true, ...result });
  } catch (err) {
    logger.warn("Weather error, using fallback", err.message);
    res.json({
      success: true,
      temp: 26,
      humidity: 70,
      description: "clear sky",
      rain: 0,
      fallback: true,
    });
  }
}

export async function getMarketTrends(req, res, next) {
  try {
    const { state, district, crop } = req.query;

    const mockTrends = {
      market: district || state || "India",
      top: ["Wheat", "Rice", "Sugarcane", "Cotton", "Maize"],
      prices: {
        wheat: "₹2,200/quintal",
        rice: "₹3,500/quintal",
        sugarcane: "₹350/quintal",
        cotton: "₹6,800/quintal",
        maize: "₹1,800/quintal",
      },
      ts: new Date().toLocaleDateString("en-IN"),
    };

    if (crop) {
      mockTrends.selectedCrop = crop;
      mockTrends.cropPrice =
        mockTrends.prices[crop?.toLowerCase()] || "Price not available";
    }

    res.json({ success: true, ...mockTrends });
  } catch (err) {
    logger.error("Market trends error", err.message);
    next(err);
  }
}

export async function analyzeSoil(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Image file is required",
      });
    }

    const { crop } = req.body;
    const imagePath = req.file.path;

    try {
      if (!config.geminiApiKey) {
        return res.json({
          success: true,
          summary:
            "The soil appears to be loamy with good organic content. pH seems neutral. Suitable for most crops.",
          recommendations: [
            "Add organic compost to improve nutrient content",
            "Test pH levels for optimal crop growth",
            "Ensure proper drainage",
          ],
          confidence: 0.75,
        });
      }

      const imageData = fs.readFileSync(imagePath);
      const base64Image = imageData.toString("base64");

      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

      const prompt = `You are an expert soil scientist. Analyze this soil/plant image and provide:
1. Soil condition assessment
2. Nutrient deficiency signs (if any)
3. Pest or disease indicators (if visible)
4. Specific recommendations for ${crop || "the crop"}
5. Overall health rating (1-10)
${crop ? `Focus on requirements for ${crop} cultivation.` : ""}
Provide practical, actionable advice for Indian farming conditions. Keep the response concise.`;

      const result = await model.generateContent([
        prompt,
        {
          inlineData: {
            data: base64Image,
            mimeType: req.file.mimetype,
          },
        },
      ]);

      const analysis = result.response.text();

      res.json({
        success: true,
        summary: analysis,
        timestamp: new Date().toISOString(),
        crop: crop || null,
      });
    } finally {
      // Clean up uploaded file
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    }
  } catch (err) {
    logger.error("Soil analysis error", err.message);

    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.json({
      success: true,
      summary:
        "Image analysis is temporarily unavailable. Please ensure good soil drainage, add organic matter, and test pH levels for optimal crop growth.",
      fallback: true,
    });
  }
}

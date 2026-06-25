import fetch from "node-fetch";
import config from "../../config/env.js";

export class GroqProvider {
  constructor() {
    this.apiKey = config.groqApiKey;
    this.baseUrl = "https://api.groq.com/openai/v1";
  }

  async analyzeImage(imageUrl, cropType, location) {
    if (!this.apiKey) throw new Error("GROQ_API_KEY not configured");

    const prompt = this.buildAnalysisPrompt(cropType, location);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
        max_tokens: 1500,
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Groq API Error Response:", errorText);
      throw new Error(`Groq API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    console.log("Groq API Response:", JSON.stringify(result, null, 2));

    const content = result.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("No content in Groq API response");
    }

    return this.parseResponse(content);
  }

  buildAnalysisPrompt(cropType, location) {
    return `You are an expert agricultural pathologist. Analyze this plant image for diseases and provide detailed recommendations.

Context:
- Crop: ${cropType || "Unknown"}
- Location: ${location?.district || "Unknown"}, ${location?.state || "Unknown"}

IMPORTANT: You must respond with ONLY valid JSON. No explanations, no markdown formatting, just pure JSON.

Required JSON structure:
{
  "disease": "specific disease name or 'Healthy' if no disease detected. If invalid image which is not related to plants, give 'Invalid image'",
  "confidence": 0.85,
  "severity": "low",
  "symptoms": ["visible symptom 1", "visible symptom 2"],
  "treatment": [
    {
      "method": "Chemical Treatment",
      "description": "Apply copper-based fungicide every 7-10 days",
      "priority": "high"
    },
    {
      "method": "Cultural Practice",
      "description": "Remove affected leaves and improve air circulation",
      "priority": "medium"
    }
  ],
  "fertilizers": ["NPK 10-10-10", "Organic compost", "Potassium sulfate"],
  "homeRemedies": ["Neem oil spray (2ml/liter)", "Baking soda solution (1tsp/liter)"],
  "prevention": ["Proper plant spacing", "Avoid overhead watering", "Regular pruning"]
}

SPECIAL CASE: If the image is invalid (not plant-related), return:
{
  "disease": "Invalid image",
  "confidence": 0,
  "severity": "unknown",
  "symptoms": [],
  "treatment": [],
  "fertilizers": [],
  "homeRemedies": [],
  "prevention": []
}

Analyze the image carefully and provide specific, actionable recommendations. Ensure all arrays have at least 2-3 items for valid plant images.`;
  }

  parseResponse(content) {
    try {
      console.log("Raw Groq Response:", content);

      let jsonStr = content.trim();

      const markdownMatch = jsonStr.match(/(?:json)?\s*([\s\S]*?)\s*/);
      if (markdownMatch) {
        jsonStr = markdownMatch[1].trim();
      }

      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonStr = jsonMatch[0];
      }

      if (jsonStr === "safe" || jsonStr.includes("safe")) {
        throw new Error(
          "Groq returned safety response instead of analysis. Please check the model configuration."
        );
      }

      const parsed = JSON.parse(jsonStr);

      if (parsed.disease === "Invalid image") {
        return {
          disease: "Invalid image",
          confidence: 0,
          severity: "unknown",
          symptoms: [],
          treatment: [],
          fertilizers: [],
          homeRemedies: [],
          prevention: [],
        };
      }

      if (!parsed.disease) parsed.disease = "Analysis incomplete";
      if (!parsed.confidence) parsed.confidence = 0.5;
      if (!parsed.severity) parsed.severity = "medium";
      if (!Array.isArray(parsed.symptoms))
        parsed.symptoms = ["Unable to determine symptoms"];
      if (!Array.isArray(parsed.treatment)) parsed.treatment = [];
      if (!Array.isArray(parsed.fertilizers)) parsed.fertilizers = [];
      if (!Array.isArray(parsed.homeRemedies)) parsed.homeRemedies = [];
      if (!Array.isArray(parsed.prevention)) parsed.prevention = [];

      return parsed;
    } catch (error) {
      console.error("Failed to parse Groq response:", error);
      console.error("Content that failed to parse:", content);

      return this.getFallbackResponse(error.message);
    }
  }

  getFallbackResponse(errorMessage) {
    return {
      disease: "Analysis failed - unable to process image",
      confidence: 0,
      severity: "unknown",
      symptoms: ["Could not analyze symptoms"],
      treatment: [
        {
          method: "Manual Inspection Required",
          description: "Please consult with local agricultural expert",
          priority: "high",
        },
      ],
      fertilizers: ["NPK 10-10-10", "Organic compost"],
      homeRemedies: ["Neem oil spray"],
      prevention: ["Regular plant monitoring"],
      error: errorMessage,
    };
  }
}

export class GeminiProvider {
  constructor() {
    this.apiKey = config.geminiApiKey;
    this.baseUrl = "https://generativelanguage.googleapis.com/v1beta";
  }

  async analyzeImage(imageUrl, cropType, location) {
    if (!this.apiKey) throw new Error("GEMINI_API_KEY not configured");

    const maxRetries = 3;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`Gemini API attempt ${attempt}/${maxRetries}`);

        const imageData = await this.fetchImageAsBase64(imageUrl);
        const prompt = this.buildAnalysisPrompt(cropType, location);

        const response = await fetch(
          `${this.baseUrl}/models/gemini-1.5-flash:generateContent?key=${this.apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    { text: prompt },
                    {
                      inline_data: {
                        mime_type: "image/jpeg",
                        data: imageData,
                      },
                    },
                  ],
                },
              ],
              generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 1500,
              },
            }),
          }
        );

        if (response.status === 503) {
          await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
          continue;
        }

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Gemini API error: ${error}`);
        }

        const result = await response.json();
        const content = result.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!content) throw new Error("No content in Gemini response");

        return this.parseResponse(content);
      } catch (error) {
        lastError = error;
        if (attempt === maxRetries) break;

        console.log(
          `Gemini attempt ${attempt} failed, retrying: ${error.message}`
        );
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }

    throw lastError;
  }

  async fetchImageAsBase64(imageUrl) {
    try {
      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.status}`);
      }
      const buffer = await response.buffer();
      return buffer.toString("base64");
    } catch (error) {
      throw new Error(`Image fetch failed: ${error.message}`);
    }
  }

  buildAnalysisPrompt(cropType, location) {
    return `Analyze this plant image as an expert agricultural pathologist.

Context:
- Crop: ${cropType || "Unknown"}  
- Location: ${location?.district}, ${location?.state}

Return ONLY valid JSON with this exact structure:
{
  "disease": "specific disease name or 'Healthy' or 'Invalid image' if not plant-related",
  "confidence": 0.85,
  "severity": "low|medium|high", 
  "symptoms": ["visible symptoms"],
  "treatment": [{"method": "treatment type", "description": "details", "priority": "high|medium|low"}],
  "fertilizers": ["specific fertilizer names"],
  "homeRemedies": ["natural remedies"],
  "prevention": ["preventive measures"]
}

IMPORTANT: If the image is not plant-related (invalid image), return empty arrays for symptoms, treatment, fertilizers, homeRemedies, and prevention.

Be specific and provide at least 2-3 items in each array for valid plant images. No explanations outside JSON.`;
  }

  parseResponse(content) {
    try {
      const jsonMatch =
        content.match(/json\s*([\s\S]*?)\s*/) || content.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? jsonMatch[1] || jsonMatch[0] : content;
      const parsed = JSON.parse(jsonStr);

      if (parsed.disease === "Invalid image") {
        return {
          disease: "Invalid image",
          confidence: 0,
          severity: "unknown",
          symptoms: [],
          treatment: [],
          fertilizers: [],
          homeRemedies: [],
          prevention: [],
        };
      }

      return this.validateResponse(parsed);
    } catch (error) {
      console.error("Failed to parse Gemini response:", error);
      return this.getFallbackResponse(error.message);
    }
  }

  validateResponse(parsed) {
    return {
      disease: parsed.disease || "Unable to determine",
      confidence: parsed.confidence || 0.5,
      severity: parsed.severity || "medium",
      symptoms: Array.isArray(parsed.symptoms)
        ? parsed.symptoms
        : ["Symptoms unclear"],
      treatment: Array.isArray(parsed.treatment) ? parsed.treatment : [],
      fertilizers: Array.isArray(parsed.fertilizers) ? parsed.fertilizers : [],
      homeRemedies: Array.isArray(parsed.homeRemedies)
        ? parsed.homeRemedies
        : [],
      prevention: Array.isArray(parsed.prevention) ? parsed.prevention : [],
    };
  }

  getFallbackResponse(errorMessage) {
    return {
      disease: "Analysis failed",
      confidence: 0,
      severity: "unknown",
      symptoms: ["Unable to analyze"],
      treatment: [
        {
          method: "Expert Consultation",
          description: "Consult local agricultural expert",
          priority: "high",
        },
      ],
      fertilizers: ["Balanced NPK fertilizer"],
      homeRemedies: ["Organic compost application"],
      prevention: ["Regular monitoring"],
      error: errorMessage,
    };
  }
}

export class HuggingFaceProvider {
  constructor() {
    this.apiKey = config.huggingFaceApiKey;
    this.baseUrl = "https://api-inference.huggingface.co/models";
  }

  async analyzeImage(imageUrl, cropType, location) {
    if (!this.apiKey) throw new Error("HUGGINGFACE_API_KEY not configured");

    try {
      const imageBuffer = await this.fetchImageBuffer(imageUrl);

      const classification = await this.classifyPlantDisease(imageBuffer);

      return this.formatResponse(classification, cropType, location);
    } catch (error) {
      console.error("HuggingFace analysis failed:", error);
      return this.getFallbackResponse(error.message);
    }
  }

  async classifyPlantDisease(imageBuffer) {
    const models = ["microsoft/resnet-50", "google/vit-base-patch16-224"];

    for (const model of models) {
      try {
        const response = await fetch(`${this.baseUrl}/${model}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/octet-stream",
          },
          body: imageBuffer,
        });

        if (response.ok) {
          return await response.json();
        }
      } catch (error) {
        console.log(`Model ${model} failed, trying next...`);
        continue;
      }
    }

    throw new Error("All HuggingFace models failed");
  }

  async fetchImageBuffer(imageUrl) {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status}`);
    }
    return await response.buffer();
  }

  formatResponse(classification, cropType, location) {
    const topResult = classification[0] || {};

    const isInvalidImage = this.checkIfInvalidImage(topResult.label);

    if (isInvalidImage) {
      return {
        disease: "Invalid image",
        confidence: 0,
        severity: "unknown",
        symptoms: [],
        treatment: [],
        fertilizers: [],
        homeRemedies: [],
        prevention: [],
      };
    }

    return {
      disease: this.interpretClassification(topResult.label, cropType),
      confidence: topResult.score || 0.5,
      severity: this.determineSeverity(topResult.score || 0.5),
      symptoms: this.generateSymptoms(topResult.label),
      treatment: this.generateTreatments(topResult.label, cropType),
      fertilizers: this.recommendFertilizers(cropType, location),
      homeRemedies: this.suggestHomeRemedies(),
      prevention: this.preventiveMeasures(cropType),
    };
  }

  checkIfInvalidImage(label) {
    if (!label) return false;

    const nonPlantKeywords = [
      "person",
      "human",
      "face",
      "car",
      "vehicle",
      "building",
      "house",
      "animal",
      "dog",
      "cat",
      "bird",
      "phone",
      "computer",
      "furniture",
      "food",
      "drink",
      "sky",
      "water",
      "rock",
      "mountain",
      "road",
    ];

    const lowerLabel = label.toLowerCase();
    return nonPlantKeywords.some((keyword) => lowerLabel.includes(keyword));
  }

  interpretClassification(label, cropType) {
    if (!label) return `${cropType} condition unknown`;

    const diseaseKeywords = {
      leaf: "Leaf disease",
      spot: "Leaf spot",
      rust: "Plant rust",
      blight: "Blight",
      yellow: "Yellowing disease",
      brown: "Brown spot disease",
      healthy: "Healthy plant",
    };

    const lowerLabel = label.toLowerCase();
    for (const [keyword, disease] of Object.entries(diseaseKeywords)) {
      if (lowerLabel.includes(keyword)) {
        return disease;
      }
    }

    return `Possible ${label.replace("/_/g", " ")} condition`;
  }

  determineSeverity(confidence) {
    if (confidence > 0.8) return "high";
    if (confidence > 0.5) return "medium";
    return "low";
  }

  generateSymptoms(label) {
    const baseSymptoms = ["Visible leaf changes", "Abnormal coloration"];
    if (label?.includes("spot")) baseSymptoms.push("Spotted pattern on leaves");
    if (label?.includes("yellow")) baseSymptoms.push("Yellowing of foliage");
    return baseSymptoms;
  }

  generateTreatments(label, cropType) {
    return [
      {
        method: "Fungicide Treatment",
        description: `Apply appropriate fungicide for ${cropType}`,
        priority: "high",
      },
      {
        method: "Cultural Practice",
        description: "Improve plant spacing and air circulation",
        priority: "medium",
      },
    ];
  }

  recommendFertilizers(cropType, location) {
    return [
      "NPK 10-10-10 (Balanced fertilizer)",
      "Organic compost",
      "Potassium sulfate for disease resistance",
    ];
  }

  suggestHomeRemedies() {
    return [
      "Neem oil spray (organic treatment)",
      "Baking soda solution (1 tsp per liter)",
      "Garlic extract spray",
    ];
  }

  preventiveMeasures(cropType) {
    return [
      "Maintain proper plant spacing",
      "Ensure good drainage",
      "Regular inspection and early detection",
      "Crop rotation practices",
    ];
  }

  getFallbackResponse(errorMessage) {
    return {
      disease: "Unable to analyze with HuggingFace",
      confidence: 0,
      severity: "unknown",
      symptoms: ["Analysis failed"],
      treatment: [
        {
          method: "Manual Inspection",
          description: "Visual inspection by agricultural expert recommended",
          priority: "high",
        },
      ],
      fertilizers: ["Balanced NPK fertilizer", "Organic matter"],
      homeRemedies: ["Neem oil application"],
      prevention: ["Regular plant monitoring"],
      error: errorMessage,
    };
  }
}

export function createProvider(providerName) {
  const providers = {
    groq: GroqProvider,
    gemini: GeminiProvider,
    huggingface: HuggingFaceProvider,
  };

  const ProviderClass = providers[providerName];
  if (!ProviderClass) {
    throw new Error(
      `Unknown provider: ${providerName}. Available: ${Object.keys(providers).join(", ")}`
    );
  }

  return new ProviderClass();
}

export async function analyzeWithFallback(
  imageUrl,
  cropType,
  location,
  preferredProvider = "groq"
) {
  const providers = ["groq", "gemini", "huggingface"];

  if (preferredProvider && providers.includes(preferredProvider)) {
    providers.splice(providers.indexOf(preferredProvider), 1);
    providers.unshift(preferredProvider);
  }

  let lastError;

  for (const providerName of providers) {
    try {
      console.log(`Trying provider: ${providerName}`);
      const provider = createProvider(providerName);
      const result = await provider.analyzeImage(imageUrl, cropType, location);

      if (result.disease === "Invalid image") {
        console.log(`Invalid image detected by provider: ${providerName}`);
        return { ...result, provider: providerName };
      }

      if (result.disease && result.disease !== "Analysis failed") {
        console.log(`Success with provider: ${providerName}`);
        return { ...result, provider: providerName };
      }
    } catch (error) {
      console.log(`Provider ${providerName} failed: ${error.message}`);
      lastError = error;
      continue;
    }
  }

  throw new Error(`All providers failed. Last error: ${lastError?.message}`);
}

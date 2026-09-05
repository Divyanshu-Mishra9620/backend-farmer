import Groq from "groq-sdk";
import config from "../../config/env.js";

const groq = new Groq({
  apiKey: config.groqApiKey,
});

export const generateFarmerResponse = async (userQuery, language, userId) => {
  try {
    const systemPrompt =
      language === "hindi"
        ? `आप एक अनुभवी कृषि विशेषज्ञ हैं जो भारतीय किसानों की मदद करते हैं। आपको निम्नलिखित क्षेत्रों में गहरी विशेषज्ञता है:

1. फसल की बुआई, देखभाल और कटाई की संपूर्ण जानकारी
2. पौधों की बीमारियों और कीट-पतंगों की पहचान व उपचार
3. मिट्टी की जांच, उर्वरक और पोषक तत्वों की सलाह
4. मौसम के अनुसार खेती की रणनीति
5. केंद्र और राज्य सरकार की कृषि योजनाओं की जानकारी
6. बाजार भाव, फसल बीमा और वित्तीय सलाह
7. जैविक खेती, प्राकृतिक उर्वरक और टिकाऊ कृषि पद्धतियां
8. सिंचाई, बीज चयन और कृषि यंत्रों की सलाह

कृपया सरल और स्पष्ट हिंदी भाषा में व्यावहारिक सुझाव दें। जवाब को 3-4 वाक्यों में संक्षिप्त रखें और यदि संभव हो तो स्थानीय तरीकों का भी उल्लेख करें।
उत्तर केवल सादा पाठ में दें। Markdown tables, बड़े headings, numbered sections, या decorative formatting का उपयोग न करें।
यदि बिंदु देने हों, तो 3-4 छोटे bullet points तक सीमित रखें और जवाब साफ़, मानवीय, तथा professional रखें।`
        : `You are an experienced agricultural expert helping Indian farmers. You have deep expertise in:

1. Complete information on crop sowing, care, and harvesting
2. Plant disease and pest identification and treatment
3. Soil testing, fertilizer, and nutrient management advice
4. Weather-based farming strategies
5. Central and state government agricultural schemes
6. Market prices, crop insurance, and financial advice
7. Organic farming, natural fertilizers, and sustainable practices
8. Irrigation, seed selection, and farm equipment guidance

Please provide practical suggestions in simple and clear English. Keep responses concise in 3-4 sentences and mention local methods when possible.
Return plain text only. Do not use markdown tables, large headings, numbered sections, or decorative formatting.
If bullets help, keep them to 3-4 short points. Keep the tone clean, practical, and human.`;

    const completion = await groq.chat.completions.create({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userQuery },
      ],
      model: "openai/gpt-oss-120b",
      temperature: 0.7,
      // This is a "thinking" model whose hidden reasoning tokens also count
      // against max_tokens — budget extra room, and hide the reasoning so it
      // never leaks into the farmer-facing (and TTS-spoken) response.
      max_tokens: 350,
      reasoning_format: "hidden",
      top_p: 1,
      stream: false,
    });

    const response = completion.choices[0]?.message?.content?.trim();

    if (!response) {
      throw new Error("No response generated from Groq");
    }

    return response;
  } catch (error) {
    console.error("Error generating AI response with Groq:", error);

    if (language === "hindi") {
      return "माफ करें, इस समय मैं आपकी समस्या का उत्तर नहीं दे पा रहा। कृपया अपना प्रश्न दोबारा स्पष्ट रूप से पूछें या किसी स्थानीय कृषि विशेषज्ञ से सलाह लें।";
    } else {
      return "Sorry, I cannot answer your query at the moment. Please ask your question again clearly or consult with a local agricultural expert.";
    }
  }
};

export const getFarmerKnowledgeContext = (language) => {
  const hindiContext = {
    commonCrops: [
      "गेहूं",
      "धान",
      "मक्का",
      "दालें",
      "सरसों",
      "आलू",
      "टमाटर",
      "प्याज",
      "गन्ना",
    ],
    seasons: {
      kharif: "खरीफ (जून-नवंबर)",
      rabi: "रबी (नवंबर-मार्च)",
      zaid: "जायद (मार्च-जून)",
    },
    commonPests: [
      "सफेद मक्खी",
      "माहू",
      "तना छेदक",
      "फल छेदक",
      "पत्ती खाने वाले कीड़े",
    ],
    organicSolutions: [
      "नीम का तेल",
      "गोमूत्र",
      "जैविक कीटनाशक",
      "प्राकृतिक उर्वरक",
    ],
  };

  const englishContext = {
    commonCrops: [
      "Wheat",
      "Rice",
      "Maize",
      "Pulses",
      "Mustard",
      "Potato",
      "Tomato",
      "Onion",
      "Sugarcane",
    ],
    seasons: {
      kharif: "Kharif (June-November)",
      rabi: "Rabi (November-March)",
      zaid: "Zaid (March-June)",
    },
    commonPests: [
      "Whitefly",
      "Aphids",
      "Stem borer",
      "Fruit borer",
      "Leaf eating caterpillars",
    ],
    organicSolutions: [
      "Neem oil",
      "Cow urine",
      "Bio-pesticides",
      "Natural fertilizers",
    ],
  };

  return language === "hindi" ? hindiContext : englishContext;
};

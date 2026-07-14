// Idempotent seed: ports the 17 government schemes that used to live as a
// hardcoded array in krishiapp/src/screens/News/governmentSchemes.ts into
// Mongo, so the /api/schemes endpoint has real data on a fresh database.
// Upserts by (sector, titles.en) so re-running after edits doesn't duplicate.
import mongoose from "mongoose";
import config from "../src/config/env.js";
import { ensureWorkingDnsResolver } from "../src/config/dns.js";
import Scheme from "../src/modules/schemes/scheme.model.js";

const SCHEMES = [
  {
    sector: "Direct Income Support",
    icon: "💰",
    titles: {
      en: "PM-KISAN: ₹6,000 Annual Direct Benefit Transfer",
      hi: "पीएम-किसान: ₹6,000 वार्षिक प्रत्यक्ष लाभ हस्तांतरण",
      te: "పిఎం-కిసాన్: ₹6,000 వార్షిక ప్రత్యక్ష ప్రయోజన బదిలీ",
    },
    description:
      "Direct bank transfer of ₹2,000 every 4 months to all landholding farmers. Over 9.7 crore farmers benefited in the 20th installment with ₹3.69 lakh crore disbursed till date.",
    benefits: "₹6,000/year",
    eligibility: "All landholding farmers",
    source: "PM-KISAN Portal",
    url: "https://pmkisan.gov.in/",
    badge: "Universal",
  },
  {
    sector: "Direct Income Support",
    icon: "💰",
    titles: {
      en: "PM Kisan Maan-Dhan: ₹3,000 Monthly Pension",
      hi: "पीएम किसान मान-धन: ₹3,000 मासिक पेंशन",
      te: "పిఎం కిసాన్ మాన్-ధన్: ₹3,000 నెలవారీ పెన్షన్",
    },
    description:
      "Monthly pension scheme for small and marginal farmers after age 60. Low monthly contribution ranging from ₹55 to ₹200 based on entry age.",
    benefits: "₹3,000/month after 60",
    eligibility: "Age 18–40, small farmers",
    source: "myScheme Portal",
    url: "https://www.myscheme.gov.in/schemes/pmkmy",
    badge: "Pension",
  },
  {
    sector: "Crop Insurance",
    icon: "🛡️",
    titles: {
      en: "PM Fasal Bima Yojana: Comprehensive Crop Insurance",
      hi: "पीएम फसल बीमा योजना: व्यापक फसल बीमा",
      te: "పిఎం ఫసల్ బీమా యోజన: సమగ్ర పంట బీమా",
    },
    description:
      "World's largest crop insurance scheme covering 50+ crops against natural calamities, pests, diseases, and post-harvest losses. Extended till 2025–26.",
    benefits: "Up to 100% crop value",
    eligibility: "All farmers with land records",
    source: "PMFBY Portal",
    url: "https://pmfby.gov.in/",
    badge: "Insurance",
  },
  {
    sector: "Crop Insurance",
    icon: "🛡️",
    titles: {
      en: "Weather Based Crop Insurance Scheme",
      hi: "मौसम आधारित फसल बीमा योजना",
      te: "వాతావరణ ఆధారిత పంట బీమా పథకం",
    },
    description:
      "Restructured weather-based crop insurance providing protection against adverse weather conditions, using weather parameters as a proxy for crop yields.",
    benefits: "Weather risk coverage",
    eligibility: "All farmers",
    source: "Insurance Companies",
    url: "https://www.india.gov.in/spotlight/weather-based-crop-insurance-scheme",
    badge: "Weather",
  },
  {
    sector: "Credit & Finance",
    icon: "🏦",
    titles: {
      en: "Kisan Credit Card: 4% Interest Subsidized Loans",
      hi: "किसान क्रेडिट कार्ड: 4% ब्याज सब्सिडी ऋण",
      te: "కిసాన్ క్రెడిట్ కార్డ్: 4% వడ్డీ సబ్సిడీ రుణాలు",
    },
    description:
      "Flexible credit facility up to ₹3 lakh at a subsidized 4% interest rate for crop production, equipment, and agricultural needs, with a revolving credit facility.",
    benefits: "Up to ₹3 lakh at 4%",
    eligibility: "All farmers",
    source: "SBI Agri Portal",
    url: "https://sbi.co.in/web/agri-rural/agriculture-banking/government-schemes",
    badge: "Credit",
  },
  {
    sector: "Credit & Finance",
    icon: "🏦",
    titles: {
      en: "Agriculture Infrastructure Fund: ₹2 Crore Loans",
      hi: "कृषि अवसंरचना कोष: ₹2 करोड़ ऋण",
      te: "వ్యవసాయ మౌలిక సదుపాయాల నిధి: ₹2 కోట్ల రుణాలు",
    },
    description:
      "3% interest subvention on loans up to ₹2 crore for infrastructure development. ₹33,209 crores sanctioned for 44,912 projects till date.",
    benefits: "Up to ₹2 crore",
    eligibility: "FPOs, cooperatives, entrepreneurs",
    source: "NABARD",
    url: "https://www.nabard.org/content1.aspx?id=23&catid=23&mid=530",
    badge: "Infrastructure",
  },
  {
    sector: "Technology & Digital",
    icon: "📱",
    titles: {
      en: "Digital Agriculture Mission: AI-Powered Farming",
      hi: "डिजिटल कृषि मिशन: एआई संचालित खेती",
      te: "డిజిటల్ వ్యవసాయ మిషన్: AI శక్తితో వ్యవసాయం",
    },
    description:
      "Union Cabinet approved mission with ₹2,817 crore budget. Provides AI, blockchain, IoT, drone technology, real-time advisory, and precision farming apps.",
    benefits: "Tech support worth ₹5,000+/year",
    eligibility: "All registered farmers",
    source: "Digital India Portal",
    url: "https://services.india.gov.in/service/listing/agriculture",
    badge: "Digital",
  },
  {
    sector: "Technology & Digital",
    icon: "📱",
    titles: {
      en: "eNAM: National Agriculture Market Platform",
      hi: "ई-नाम: राष्ट्रीय कृषि बाजार मंच",
      te: "ఈ-నాం: జాతీయ వ్యవసాయ మార్కెట్ వేదిక",
    },
    description:
      "Pan-India electronic trading portal networking existing APMC mandis. Provides transparent price discovery, online trading, and direct market access.",
    benefits: "Better price realization",
    eligibility: "All farmers & traders",
    source: "eNAM Portal",
    url: "https://www.enam.gov.in/",
    badge: "Market",
  },
  {
    sector: "Water & Solar",
    icon: "💧",
    titles: {
      en: "PM KUSUM: Solar Pump & Panel Subsidies",
      hi: "पीएम कुसुम: सोलर पंप व पैनल सब्सिडी",
      te: "పిఎం కుసుమ్: సోలార్ పంప్ & ప్యానెల్ సబ్సిడీలు",
    },
    description:
      "Provides 60% subsidy on solar water pumps and panels. Farmers can sell excess power generated back to the grid, creating an additional income source.",
    benefits: "60% subsidy + income",
    eligibility: "All farmers",
    source: "MNRE Portal",
    url: "https://www.mnre.gov.in/solar/schemes/",
    badge: "Solar",
  },
  {
    sector: "Water & Solar",
    icon: "💧",
    titles: {
      en: "PM Krishi Sinchai Yojana: Drip Irrigation Support",
      hi: "पीएम कृषि सिंचाई योजना: ड्रिप सिंचाई सहायता",
      te: "పిఎం కృషి సిన్చయ్ యోజన: డ్రిప్ సేద్య మద్దతు",
    },
    description:
      "Per Drop More Crop component providing 45–55% subsidy on drip and sprinkler irrigation systems to enhance water use efficiency.",
    benefits: "45–55% subsidy",
    eligibility: "All farmers",
    source: "myScheme Portal",
    url: "https://www.myscheme.gov.in/schemes/pmksy-pdmc",
    badge: "Irrigation",
  },
  {
    sector: "Fisheries & Allied",
    icon: "🐟",
    titles: {
      en: "PM Matsya Sampada Yojana: Blue Revolution",
      hi: "पीएम मत्स्य संपदा योजना: नीली क्रांति",
      te: "పిఎం మత్స్య సంపత యోజన: నీలి విప్లవం",
    },
    description:
      "Comprehensive fisheries development scheme with ₹20,050 crore investment. Supports aquaculture, infrastructure, processing, and marketing with 39 startups approved.",
    benefits: "Up to ₹1.5L subsidy",
    eligibility: "Fishermen & entrepreneurs",
    source: "PMMSY Portal",
    url: "https://pmmsy.dof.gov.in/",
    badge: "Fisheries",
  },
  {
    sector: "Fisheries & Allied",
    icon: "🐟",
    titles: {
      en: "PM-MKSSY: Fisheries Cooperative Support",
      hi: "पीएम-एमकेएसएसवाई: मत्स्य सहकारिता सहायता",
      te: "పిఎం-MKSSY: మత్స్య సహకార మద్దతు",
    },
    description:
      "Sub-scheme of PMMSY supporting 5,500 primary fisheries cooperatives with mentoring, capacity building, and financial support for collective farming.",
    benefits: "Cooperative strengthening",
    eligibility: "Fisheries cooperatives",
    source: "PM-MKSSY Portal",
    url: "https://pmmkssy.dof.gov.in/",
    badge: "Cooperative",
  },
  {
    sector: "Organic & Sustainable",
    icon: "🌱",
    titles: {
      en: "Paramparagat Krishi Vikas Yojana: Organic Farming",
      hi: "परम्परागत कृषि विकास योजना: जैविक खेती",
      te: "పారంపరిగత కృషి వికాస్ యోజన: సేంద్రియ వ్యవసాయం",
    },
    description:
      "Promotes cluster-based organic farming with ₹31,500 per hectare support for three-year organic clusters including certification and marketing assistance.",
    benefits: "₹31,500 per hectare",
    eligibility: "Organic farmer groups",
    source: "Organic Farming Portal",
    url: "https://www.india.gov.in/spotlight/paramparagat-krishi-vikas-yojana",
    badge: "Organic",
  },
  {
    sector: "Organic & Sustainable",
    icon: "🌱",
    titles: {
      en: "Soil Health Card Scheme: Nutrient Management",
      hi: "मृदा स्वास्थ्य कार्ड योजना: पोषक प्रबंधन",
      te: "మట్టి ఆరోగ్య కార్డ్ పథకం: పోషక నిర్వహణ",
    },
    description:
      "Bi-annual soil nutrient analysis reports with tailored fertilizer recommendations to promote balanced fertilizer use and soil health improvement.",
    benefits: "Free soil testing",
    eligibility: "All farmers",
    source: "Agriculture Portal",
    url: "https://www.india.gov.in/spotlight/soil-health-card",
    badge: "Soil Health",
  },
  {
    sector: "Machinery & Equipment",
    icon: "🚜",
    titles: {
      en: "Sub-Mission on Agricultural Mechanization",
      hi: "कृषि यांत्रीकरण पर उप-मिशन",
      te: "వ్యవసాయ యంత్రీకరణ ఉప-మిషన్",
    },
    description:
      "Direct Benefit Transfer for farm machinery with 40–60% subsidy on tractors, harvesters, implements, and custom hiring centers to reduce labor costs.",
    benefits: "40–60% subsidy",
    eligibility: "All farmers",
    source: "DBT Agriculture",
    url: "https://agrimachinery.nic.in/",
    badge: "Machinery",
  },
  {
    sector: "Market Support",
    icon: "📈",
    titles: {
      en: "PM-AASHA: Minimum Support Price Scheme",
      hi: "पीएम-आशा: न्यूनतम समर्थन मूल्य योजना",
      te: "పిఎం-ఆశా: కనీస మద్దతు ధర పథకం",
    },
    description:
      "Ensures remunerative prices for farmers through MSP for notified crops with ₹20,000 crore budget benefiting 120 million farmers across India.",
    benefits: "MSP guarantee",
    eligibility: "All crop farmers",
    source: "Agriculture Ministry",
    url: "https://www.myscheme.gov.in/schemes/pmaasha",
    badge: "MSP",
  },
  {
    sector: "Market Support",
    icon: "📈",
    titles: {
      en: "10,000 FPO Scheme: Farmer Collectives",
      hi: "10,000 एफपीओ योजना: किसान सामूहिक",
      te: "10,000 FPO పథకం: రైతు సమూహాలు",
    },
    description:
      "Formation of Farmer Producer Organizations with grants up to ₹18 lakh per FPO in phases for collective bargaining and shared technology access.",
    benefits: "Up to ₹18 lakh/FPO",
    eligibility: "Farmer groups",
    source: "NABARD",
    url: "https://www.nabard.org/auth/writereaddata/tender/1608201411253000-FPO-Guidelines.pdf",
    badge: "Collective",
  },
].map((scheme, index) => ({ ...scheme, order: index }));

async function seed() {
  ensureWorkingDnsResolver();
  await mongoose.connect(config.mongoUri);
  console.log("MongoDB connected");

  let created = 0;
  let updated = 0;
  for (const scheme of SCHEMES) {
    const filter = { sector: scheme.sector, "titles.en": scheme.titles.en };
    // Mongoose 8's `rawResult` no longer surfaces the driver's
    // lastErrorObject.upserted flag, so upsert-vs-update has to be checked
    // explicitly rather than inferred from findOneAndUpdate's return value.
    const existedBefore = await Scheme.exists(filter);
    await Scheme.findOneAndUpdate(filter, scheme, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    });
    if (existedBefore) updated += 1;
    else created += 1;
  }

  console.log(`Seed complete: ${created} created, ${updated} updated (${SCHEMES.length} total).`);
  await mongoose.disconnect();
}

seed().catch((error) => {
  console.error("Seeding schemes failed:", error);
  process.exit(1);
});

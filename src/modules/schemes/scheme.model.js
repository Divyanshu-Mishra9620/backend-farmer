import mongoose from "mongoose";

const titlesSchema = new mongoose.Schema(
  {
    en: { type: String, required: true, trim: true },
    hi: { type: String, required: true, trim: true },
    te: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const schemeSchema = new mongoose.Schema(
  {
    sector: { type: String, required: true, trim: true },
    icon: { type: String, required: true, trim: true },
    titles: { type: titlesSchema, required: true },
    description: { type: String, required: true, trim: true },
    benefits: { type: String, required: true, trim: true },
    eligibility: { type: String, required: true, trim: true },
    source: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
    badge: { type: String, required: true, trim: true },
    order: { type: Number, required: true, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

schemeSchema.index({ isActive: 1, order: 1 });
schemeSchema.index({ sector: 1, "titles.en": 1 }, { unique: true });

export default mongoose.model("Scheme", schemeSchema);

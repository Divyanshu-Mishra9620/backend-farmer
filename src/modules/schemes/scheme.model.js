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
    // Preserves the curated display order (grouped by sector) instead of
    // relying on insertion/_id order, which the seed script won't control
    // once schemes are edited individually via the admin routes.
    order: { type: Number, required: true, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

schemeSchema.index({ isActive: 1, order: 1 });
// Enforces the seed script's dedup key at the DB layer, so a concurrent
// re-run or a racing admin create() can't produce duplicate scheme docs —
// the app-level "does it already exist" check alone can't prevent that.
schemeSchema.index({ sector: 1, "titles.en": 1 }, { unique: true });

export default mongoose.model("Scheme", schemeSchema);

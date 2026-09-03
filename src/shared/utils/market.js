import config from "../../config/env.js";
import { marketCache, LRUCache } from "./cache.js";
import { createLogger } from "./logger.js";

const logger = createLogger("Market");

export class MarketServiceError extends Error {}

/**
 * data.gov.in "Current Daily Price of Various Commodities from Various
 * Markets (Mandi)" resource (9ef84268-d588-465a-a308-a864a43d0070). Its
 * `filters[<field>]` params do a tokenized match, not an exact string match —
 * e.g. district="Pauri Garhwal" matches records stored as "Garhwal (Pauri)" —
 * so callers can pass whatever state/district text they already have without
 * normalizing it to the dataset's exact spelling.
 */
function buildUrl({ state, district, commodity, limit }) {
  const params = new URLSearchParams({
    "api-key": config.marketApiKey,
    format: "json",
    limit: String(limit),
  });
  if (state) params.set("filters[state]", state);
  if (district) params.set("filters[district]", district);
  if (commodity) params.set("filters[commodity]", commodity);
  return `${config.marketApiUrl}?${params.toString()}`;
}

function normalizeRecord(r) {
  return {
    state: r.state,
    district: r.district,
    market: r.market,
    commodity: r.commodity,
    variety: r.variety,
    grade: r.grade,
    arrivalDate: r.arrival_date,
    minPrice: Number(r.min_price),
    maxPrice: Number(r.max_price),
    modalPrice: Number(r.modal_price),
  };
}

/**
 * Fetches live mandi prices, grouped by commodity. Throws MarketServiceError
 * on any failure — callers must show "unavailable", not a guessed price.
 */
export async function fetchMandiPrices({ state, district, commodity, limit = 40 } = {}) {
  if (!config.marketApiUrl || !config.marketApiKey) {
    throw new MarketServiceError("Market data API is not configured.");
  }

  const cacheKey = LRUCache.generateKey("market", state || "", district || "", commodity || "");
  const cached = marketCache.get(cacheKey);
  if (cached) {
    logger.info("Market cache hit");
    return { ...cached, cached: true };
  }

  let response;
  try {
    response = await fetch(buildUrl({ state, district, commodity, limit }));
  } catch (err) {
    throw new MarketServiceError(`Could not reach the market data service: ${err.message}`);
  }

  if (!response.ok) {
    throw new MarketServiceError(`Market data service error: ${response.status}`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new MarketServiceError("Market data service returned a non-JSON response.");
  }

  const records = Array.isArray(data.records) ? data.records.map(normalizeRecord) : [];

  const byCommodity = new Map();
  for (const rec of records) {
    if (!rec.commodity || Number.isNaN(rec.modalPrice)) continue;
    const key = rec.commodity.toLowerCase();
    const bucket = byCommodity.get(key) || { commodity: rec.commodity, modalPrices: [], latest: rec };
    bucket.modalPrices.push(rec.modalPrice);
    // arrival_date is DD/MM/YYYY; string comparison isn't chronological, so
    // just keep the first record seen (the API already orders by relevance).
    byCommodity.set(key, bucket);
  }

  const commodityPrices = Array.from(byCommodity.values()).map((b) => ({
    commodity: b.commodity,
    modalPrice: Math.round(b.modalPrices.reduce((a, v) => a + v, 0) / b.modalPrices.length),
    market: b.latest.market,
    arrivalDate: b.latest.arrivalDate,
  }));

  const result = {
    records,
    commodityPrices,
    total: data.total ?? records.length,
    source: "data.gov.in",
  };

  marketCache.set(cacheKey, result);
  return result;
}

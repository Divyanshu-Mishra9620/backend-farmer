import { geoCache, LRUCache } from "./cache.js";
import { createLogger } from "./logger.js";

const logger = createLogger("Geocode");

/**
 * Forward-geocodes a free-text address via OpenCage. Returns null when the
 * address genuinely has no match (caller decides how to respond to that);
 * throws on a network/service failure so callers can apply their own
 * fallback behavior.
 */
export async function geocodeAddress(address) {
  const cacheKey = LRUCache.generateKey("geo", address);
  const cached = geoCache.get(cacheKey);
  if (cached) {
    logger.info("Geocode cache hit", address);
    return { ...cached, cached: true };
  }

  const response = await fetch(
    `https://api.opencagedata.com/geocode/v1/json?q=${encodeURIComponent(address)}&key=${process.env.OPENCAGE_API_KEY || "demo"}&limit=1&countrycode=IN`,
  );

  if (!response.ok) {
    throw new Error("Geocoding service error");
  }

  const data = await response.json();

  if (!data.results || data.results.length === 0) {
    return null;
  }

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

  return geoData;
}

import crypto from "crypto";

class LRUCache {
  constructor({ maxSize = 500, defaultTTL = 30 * 60 * 1000 } = {}) {
    this.maxSize = maxSize;
    this.defaultTTL = defaultTTL;
    this.cache = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Generate a cache key from arbitrary data
   */
  static generateKey(...parts) {
    const raw = parts
      .map((p) => (typeof p === "object" ? JSON.stringify(p) : String(p)))
      .join("|");
    return crypto.createHash("md5").update(raw).digest("hex");
  }

  /**
   * Get a value from cache. Returns null if expired or missing.
   */
  get(key) {
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    // Check TTL
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits++;

    return entry.value;
  }

  /**
   * Set a value in cache with optional TTL override
   */
  set(key, value, ttl = this.defaultTTL) {
    // Remove existing entry if present
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttl,
      createdAt: Date.now(),
    });
  }

  /**
   * Check if key exists and is not expired
   */
  has(key) {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Remove a specific key
   */
  delete(key) {
    return this.cache.delete(key);
  }

  /**
   * Clear all entries
   */
  clear() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? ((this.hits / total) * 100).toFixed(1) + "%" : "0%",
    };
  }

  /**
   * Remove all expired entries (housekeeping)
   */
  purgeExpired() {
    const now = Date.now();
    let purged = 0;
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        purged++;
      }
    }
    return purged;
  }
}

// Pre-configured cache instances for different purposes
const TTL = {
  AI_RESPONSE: 30 * 60 * 1000,
  WEATHER: 10 * 60 * 1000,
  MARKET: 60 * 60 * 1000,
  USER_PREFS: 5 * 60 * 1000,
  GEOCODE: 24 * 60 * 60 * 1000,
};

// Singleton caches
const aiCache = new LRUCache({ maxSize: 200, defaultTTL: TTL.AI_RESPONSE });
const weatherCache = new LRUCache({ maxSize: 50, defaultTTL: TTL.WEATHER });
const geoCache = new LRUCache({ maxSize: 100, defaultTTL: TTL.GEOCODE });
const marketCache = new LRUCache({ maxSize: 100, defaultTTL: TTL.MARKET });

// Periodic cleanup every 10 minutes
setInterval(
  () => {
    aiCache.purgeExpired();
    weatherCache.purgeExpired();
    geoCache.purgeExpired();
    marketCache.purgeExpired();
  },
  10 * 60 * 1000,
);

export { LRUCache, TTL, aiCache, weatherCache, geoCache, marketCache };
export default LRUCache;

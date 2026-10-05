import crypto from "crypto";

class LRUCache {
  constructor({ maxSize = 500, defaultTTL = 30 * 60 * 1000 } = {}) {
    this.maxSize = maxSize;
    this.defaultTTL = defaultTTL;
    this.cache = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  static generateKey(...parts) {
    const raw = parts
      .map((p) => (typeof p === "object" ? JSON.stringify(p) : String(p)))
      .join("|");
    return crypto.createHash("md5").update(raw).digest("hex");
  }

  get(key) {
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits++;

    return entry.value;
  }

  set(key, value, ttl = this.defaultTTL) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

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

  has(key) {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  delete(key) {
    return this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

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

const TTL = {
  AI_RESPONSE: 30 * 60 * 1000,
  WEATHER: 10 * 60 * 1000,
  MARKET: 60 * 60 * 1000,
  USER_PREFS: 5 * 60 * 1000,
  GEOCODE: 24 * 60 * 60 * 1000,
};

const aiCache = new LRUCache({ maxSize: 200, defaultTTL: TTL.AI_RESPONSE });
const weatherCache = new LRUCache({ maxSize: 50, defaultTTL: TTL.WEATHER });
const geoCache = new LRUCache({ maxSize: 100, defaultTTL: TTL.GEOCODE });
const marketCache = new LRUCache({ maxSize: 100, defaultTTL: TTL.MARKET });

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

import { weatherCache, LRUCache } from "./cache.js";
import { createLogger } from "./logger.js";

const logger = createLogger("Weather");

export async function fetchCurrentWeather(lat, lon) {
  const cacheKey = LRUCache.generateKey("weather", lat, lon);
  const cached = weatherCache.get(cacheKey);
  if (cached) {
    logger.info("Weather cache hit");
    return { ...cached, cached: true };
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

  weatherCache.set(cacheKey, result);

  return result;
}

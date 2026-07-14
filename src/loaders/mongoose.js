import mongoose from "mongoose";
import config from "../config/env.js";
import { ensureWorkingDnsResolver } from "../config/dns.js";

function cleanUri(uri) {
  if (!uri) return uri;
  return uri.trim().replace(/^"|"$/g, "");
}

export default async function connectDB() {
  ensureWorkingDnsResolver();

  const rawUri = config.mongoUri;
  const mongoUri = cleanUri(rawUri);

  if (!mongoUri) {
    console.error("MongoDB URI is not set. Check your .env or env config.");
    process.exit(1);
  }

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await mongoose.connect(mongoUri, { autoIndex: true });
      console.log("MongoDB connected");
      return;
    } catch (error) {
      console.error(
        `DB connection attempt ${attempt} failed:`,
        error.message || error,
      );
      if (attempt < maxRetries) {
        const backoff = attempt * 1000;
        console.log(`Retrying in ${backoff}ms...`);
        await new Promise((r) => setTimeout(r, backoff));
      } else {
        console.error(
          "All MongoDB connection attempts failed. Please verify your connection string and network/DNS settings.",
        );
        process.exit(1);
      }
    }
  }
}

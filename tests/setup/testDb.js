import mongoose from "mongoose";
import connectDB from "../../src/loaders/mongoose.js";

export async function connectTestDB() {
  if (mongoose.connection.readyState === 0) {
    await connectDB();
  }
}

export async function disconnectTestDB() {
  await mongoose.connection.close();
}

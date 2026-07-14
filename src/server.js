import http from "http";
import config from "./config/env.js";
import initApp from "./loaders/index.js";
import { initSocket } from "./modules/chat/socket.js";
import { startWeatherAlertJob } from "./jobs/weatherAlertJob.js";

(async () => {
  const app = await initApp();

  const server = http.createServer(app);

  const io = initSocket(server);

  app.set("io", io);

  server.listen(config.port, () => {
    console.log(` Server running on http://localhost:${config.port}`);
    console.log(`Socket.IO server ready for real-time connections`);
    console.log(` Farmer Assistant API ready to serve`);

    if (config.nodeEnv !== "test") {
      startWeatherAlertJob();
    }
  });

  process.on("SIGTERM", () => {
    console.log("SIGTERM received, shutting down gracefully");
    server.close(() => {
      console.log("Server closed");
      process.exit(0);
    });
  });

  process.on("SIGINT", () => {
    console.log("SIGINT received, shutting down gracefully");
    server.close(() => {
      console.log("Server closed");
      process.exit(0);
    });
  });
})().catch((error) => {
  console.error("Failed to start servers:", error);
  process.exit(1);
});

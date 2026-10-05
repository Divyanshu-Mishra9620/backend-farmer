const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
};

const isProduction = process.env.NODE_ENV === "production";
const currentLevel = isProduction ? LOG_LEVELS.INFO : LOG_LEVELS.DEBUG;

function formatTimestamp() {
  return new Date().toISOString();
}

function formatMessage(level, module, message, data) {
  const timestamp = formatTimestamp();
  const prefix = `[${timestamp}] [${level}]${module ? ` [${module}]` : ""}`;

  if (data !== undefined) {
    return `${prefix} ${message} ${typeof data === "object" ? JSON.stringify(data) : data}`;
  }
  return `${prefix} ${message}`;
}

function createLogger(module = "") {
  return {
    error(message, data) {
      if (currentLevel >= LOG_LEVELS.ERROR) {
        console.error(formatMessage("ERROR", module, message, data));
      }
    },

    warn(message, data) {
      if (currentLevel >= LOG_LEVELS.WARN) {
        console.warn(formatMessage("WARN", module, message, data));
      }
    },

    info(message, data) {
      if (currentLevel >= LOG_LEVELS.INFO) {
        console.log(formatMessage("INFO", module, message, data));
      }
    },

    debug(message, data) {
      if (currentLevel >= LOG_LEVELS.DEBUG) {
        console.log(formatMessage("DEBUG", module, message, data));
      }
    },

    request(req, statusCode, durationMs) {
      const userId = req.user?.id || "anonymous";
      const msg = `${req.method} ${req.originalUrl} → ${statusCode} (${durationMs}ms) [user:${userId}]`;
      if (statusCode >= 500) {
        this.error(msg);
      } else if (statusCode >= 400) {
        this.warn(msg);
      } else {
        this.info(msg);
      }
    },
  };
}

const logger = createLogger();

export { createLogger };
export default logger;

import { createLogger } from "../utils/logger.js";

const logger = createLogger("ErrorHandler");

const ERROR_TYPES = {
  VALIDATION: { status: 400, code: "VALIDATION_ERROR" },
  UNAUTHORIZED: { status: 401, code: "UNAUTHORIZED" },
  FORBIDDEN: { status: 403, code: "FORBIDDEN" },
  NOT_FOUND: { status: 404, code: "NOT_FOUND" },
  CONFLICT: { status: 409, code: "CONFLICT" },
  RATE_LIMIT: { status: 429, code: "RATE_LIMIT_EXCEEDED" },
  AI_SERVICE: { status: 503, code: "AI_SERVICE_ERROR" },
  REQUEST_TIMEOUT: { status: 504, code: "REQUEST_TIMEOUT" },
  DATABASE: { status: 500, code: "DATABASE_ERROR" },
  INTERNAL: { status: 500, code: "INTERNAL_ERROR" },
};

// Statuses set by our own httpError() (marked with err.isAppError) map
// directly to a type instead of falling through the keyword-matching below,
// which doesn't know about e.g. 409 and would otherwise mislabel a correct
// 409 response as "INTERNAL_ERROR" in the response body.
const STATUS_TO_TYPE = {
  400: ERROR_TYPES.VALIDATION,
  401: ERROR_TYPES.UNAUTHORIZED,
  403: ERROR_TYPES.FORBIDDEN,
  404: ERROR_TYPES.NOT_FOUND,
  409: ERROR_TYPES.CONFLICT,
  429: ERROR_TYPES.RATE_LIMIT,
  503: ERROR_TYPES.AI_SERVICE,
  504: ERROR_TYPES.REQUEST_TIMEOUT,
};

function categorizeError(err) {
  if (err.isAppError && STATUS_TO_TYPE[err.status]) {
    return STATUS_TO_TYPE[err.status];
  }

  const message = err.message?.toLowerCase() || "";

  if (
    err.name === "ValidationError" ||
    err.name === "CastError" ||
    message.includes("validation")
  ) {
    return ERROR_TYPES.VALIDATION;
  }
  if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
    return ERROR_TYPES.UNAUTHORIZED;
  }
  if (message.includes("unauthorized") || err.status === 401) {
    return ERROR_TYPES.UNAUTHORIZED;
  }
  if (message.includes("forbidden") || err.status === 403) {
    return ERROR_TYPES.FORBIDDEN;
  }
  if (message.includes("not found") || err.status === 404) {
    return ERROR_TYPES.NOT_FOUND;
  }
  if (
    message.includes("rate limit") ||
    message.includes("too many") ||
    err.status === 429
  ) {
    return ERROR_TYPES.RATE_LIMIT;
  }
  if (
    message.includes("openrouter") ||
    message.includes("groq") ||
    message.includes("gemini") ||
    message.includes("ai service")
  ) {
    return ERROR_TYPES.AI_SERVICE;
  }
  if (
    err.name === "MongoError" ||
    err.name === "MongoServerError" ||
    message.includes("mongo")
  ) {
    return ERROR_TYPES.DATABASE;
  }

  return ERROR_TYPES.INTERNAL;
}

function getUserFriendlyMessage(errorType, originalMessage) {
  switch (errorType.code) {
    case "VALIDATION_ERROR":
      return originalMessage || "Invalid input data. Please check your request.";
    case "UNAUTHORIZED":
      return "Please log in to continue.";
    case "FORBIDDEN":
      return "You don't have permission to perform this action.";
    case "NOT_FOUND":
      return "The requested resource was not found.";
    case "CONFLICT":
      return originalMessage || "This already exists.";
    case "RATE_LIMIT_EXCEEDED":
      return "Too many requests. Please wait a moment and try again.";
    case "AI_SERVICE_ERROR":
      return "The AI service is temporarily unavailable. Please try again shortly.";
    case "DATABASE_ERROR":
      return "A database error occurred. Please try again.";
    default:
      return "Something went wrong. Please try again.";
  }
}

export default function errorHandler(err, req, res, _next) {
  const errorType = categorizeError(err);
  const statusCode = err.status || errorType.status;
  const isProduction = process.env.NODE_ENV === "production";

  // Log with context
  logger.error(
    `${req.method} ${req.originalUrl} → ${statusCode} [${errorType.code}]`,
    {
      message: err.message,
      userId: req.user?.id || "anonymous",
      ...(isProduction ? {} : { stack: err.stack }),
    },
  );

  // err.isAppError is only ever set by our own httpError() deliberately
  // throwing a user-facing error ("Invalid email or password", "User already
  // exists..."). It's a distinct flag rather than checking `err.status`
  // alone, because plenty of third-party errors also set `.status` without
  // it being a safe message to show — e.g. Express's body-parser sets
  // `.status = 400` on malformed JSON, but that message is a raw V8 parser
  // string, never meant to reach a client.
  const response = {
    success: false,
    error: {
      code: errorType.code,
      message: err.isAppError ? err.message : getUserFriendlyMessage(errorType, err.message),
    },
  };

  // Include debug info in development only
  if (!isProduction) {
    response.error.debug = {
      originalMessage: err.message,
      stack: err.stack?.split("\n").slice(0, 5),
    };
  }

  res.status(statusCode).json(response);
}

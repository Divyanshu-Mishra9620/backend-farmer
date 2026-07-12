export function safeErrorMessage(error, fallback = "An unexpected error occurred") {
  return process.env.NODE_ENV === "production"
    ? fallback
    : error?.message || fallback;
}

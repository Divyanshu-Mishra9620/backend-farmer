export default function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  // Distinguishes our own deliberately user-facing errors from third-party
  // errors that also happen to set `.status` (e.g. Express's body-parser
  // sets `.status = 400` on malformed JSON, but that message is a raw V8
  // parser string, never meant to reach a client) — see errorHandler.js.
  err.isAppError = true;
  return err;
}

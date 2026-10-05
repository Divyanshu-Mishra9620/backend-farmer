export default function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.isAppError = true;
  return err;
}

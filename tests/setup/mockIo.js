export function attachMockIo(app) {
  app.set("io", { to: () => ({ emit: () => {} }) });
}

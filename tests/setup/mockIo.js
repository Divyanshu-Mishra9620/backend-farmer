// Controllers that broadcast over Socket.IO (communityChat, etc.) call
// req.app.get("io"). In production server.js sets that up via
// app.set("io", io) after initSocket(server); tests only build the Express
// app directly via expressLoader(), so without this stub those calls throw
// "Cannot read properties of undefined (reading 'to')".
export function attachMockIo(app) {
  app.set("io", { to: () => ({ emit: () => {} }) });
}

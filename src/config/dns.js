import dns from "dns";

export function ensureWorkingDnsResolver() {
  const servers = dns.getServers();
  const loopbackOnly =
    servers.length > 0 && servers.every((s) => s === "127.0.0.1" || s === "::1");
  if (loopbackOnly) {
    dns.setServers(["8.8.8.8", "1.1.1.1"]);
  }
}

import dns from "dns";

/**
 * Some local DNS proxies (VPN clients, antivirus "safe DNS" features, etc.)
 * resolve normal A/AAAA lookups fine but refuse SRV queries outright, which
 * breaks `mongodb+srv://` connection strings with a misleading
 * "querySrv ECONNREFUSED" error — everything else about the network is fine.
 * If Node's resolver is pointed only at loopback, fall back to public
 * resolvers that handle SRV correctly instead of leaving this unexplained.
 */
export function ensureWorkingDnsResolver() {
  const servers = dns.getServers();
  const loopbackOnly =
    servers.length > 0 && servers.every((s) => s === "127.0.0.1" || s === "::1");
  if (loopbackOnly) {
    dns.setServers(["8.8.8.8", "1.1.1.1"]);
  }
}

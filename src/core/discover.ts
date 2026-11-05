import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";

/** How long a beacon stays in the peer list. Beacons are sent every 2 seconds. */
export const PEER_TTL_MS = 12_000;

export interface BeaconBody {
  v: 1;
  name: string;
  pub: string;
  port: number;
  lan: string[];
  ts: string[];
}

/**
 * Identity advertisement. The one-time code is not included: it is asked once,
 * on the first send, and is not useful to anyone who can hear the beacon.
 */
export function beaconPayload(body: BeaconBody): Buffer {
  return Buffer.from(JSON.stringify(body));
}

export function beaconDestinations(broadcasts: readonly string[], vpnHosts: readonly string[]): string[] {
  return [...new Set(["255.255.255.255", ...broadcasts, ...vpnHosts])];
}

/** Directed broadcast for an interface, when the netmask is wider than a single host. */
export function ipv4Broadcast(address: string, netmask: string): string | null {
  const ip = parseV4(address);
  const mask = parseV4(netmask);
  if (!ip || !mask) return null;
  if (mask.every((part) => part === 255)) return null;
  const broadcast = ip.map((part, index) => (part | (mask[index]! ^ 255)) & 255);
  const text = broadcast.join(".");
  if (text === "255.255.255.255" || text === address) return null;
  return text;
}

export function localBroadcasts(): string[] {
  const found = new Set<string>();
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.internal || address.family !== "IPv4") continue;
      const broadcast = ipv4Broadcast(address.address, address.netmask);
      if (broadcast) found.add(broadcast);
    }
  }
  return [...found];
}

/** IPv4 addresses of peers on an existing Tailscale or WireGuard network. */
export function peerIpsFromTailscaleStatus(raw: string): string[] {
  let data: { Peer?: Record<string, { TailscaleIPs?: string[]; Online?: boolean }> | null };
  try {
    data = JSON.parse(raw) as typeof data;
  } catch {
    return [];
  }
  const ips: string[] = [];
  for (const peer of Object.values(data.Peer ?? {})) {
    if (peer.Online === false) continue;
    for (const ip of peer.TailscaleIPs ?? []) {
      if (parseV4(ip)) ips.push(ip);
    }
  }
  return ips;
}

/** `wg show all dump`: peer lines carry allowed IPs in the fourth field. */
export function peerIpsFromWgDump(raw: string): string[] {
  const ips: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const fields = line.split("\t");
    if (fields.length < 4) continue;
    const portOrEndpoint = fields[2] ?? "";
    if (/^\d+$/.test(portOrEndpoint) || portOrEndpoint === "off") continue;
    for (const item of (fields[3] ?? "").split(",")) {
      const [ip, prefix] = item.trim().split("/");
      if (!ip || !parseV4(ip) || prefix !== "32") continue;
      ips.push(ip);
    }
  }
  return ips;
}

export async function vpnProbeHosts(signal?: AbortSignal): Promise<string[]> {
  const [tailscale, wireguard] = await Promise.all([
    execText("tailscale", ["status", "--json"], signal),
    execText("wg", ["show", "all", "dump"], signal),
  ]);
  const hosts = new Set<string>();
  if (tailscale) {
    for (const ip of peerIpsFromTailscaleStatus(tailscale)) hosts.add(ip);
  }
  if (wireguard) {
    for (const ip of peerIpsFromWgDump(wireguard)) hosts.add(ip);
  }
  return [...hosts];
}

export function preferSource(from: string, listed: readonly string[]): string[] {
  return [from, ...listed.filter((item) => item !== from)];
}

function parseV4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return numbers;
}

function execText(command: string, args: string[], signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 1500, signal }, (error, stdout) => {
      if (error) resolve(null);
      else resolve(stdout);
    });
  });
}

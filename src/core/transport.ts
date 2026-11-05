/**
 * Reachability, first match wins: same LAN, then an existing private network
 * such as Tailscale (detected, never shipped), then the relay.
 */

export const TRANSPORT_ORDER = ["lan", "tailscale", "relay"] as const;
export type TransportKind = (typeof TRANSPORT_ORDER)[number];

export interface Reachability {
  /** A LAN address for the peer accepted a connection. */
  lan: boolean;
  /** This machine has Tailscale (or a tailscale interface). The program is not bundled. */
  tailscaleDetected: boolean;
  /** A Tailscale address for the peer accepted a connection. */
  tailscale: boolean;
  /** A relay address is configured and the relay accepted a routing connection. */
  relay: boolean;
}

export function selectTransport(reach: Reachability): TransportKind | null {
  for (const kind of TRANSPORT_ORDER) {
    if (kind === "lan" && reach.lan) return "lan";
    if (kind === "tailscale") {
      if (!reach.tailscaleDetected) continue;
      if (reach.tailscale) return "tailscale";
      continue;
    }
    if (kind === "relay" && reach.relay) return "relay";
  }
  return null;
}

/** Interface names that mean Tailscale is present. `utun` alone is not enough. */
export function tailscaleInterfacePresent(names: readonly string[]): boolean {
  return names.some((name) => /^tailscale/i.test(name));
}

import { execFile } from "node:child_process";
import { once } from "node:events";
import { connect as connectTcp, type Socket } from "node:net";
import { networkInterfaces } from "node:os";

import { CODE_ALPHABET, RELAY_PORT } from "./constants.ts";
import { parseHostPort, type Pairing, type TeleportConfig } from "./config.ts";
import type { Identity } from "./crypto.ts";
import { handshakeSender, type Hello, type PeerLink } from "./link.ts";
import { readLine, writeLine } from "./lines.ts";
import { selectTransport, tailscaleInterfacePresent, type TransportKind } from "./transport.ts";

export interface RemotePeer {
  name: string;
  publicKey: string;
  port: number;
  code?: string;
  /** The service accepts a first connection without a one-time code. */
  acceptAll?: boolean;
  lan: string[];
  tailscale: string[];
  lastSeen: number;
}

export interface ConnectedPeer {
  link: PeerLink;
  hello: Hello;
  transport: TransportKind;
  viaCode: boolean;
  publicKey: string;
}

export function canConnect(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connectTcp({ host, port, timeout: timeoutMs });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** True when Tailscale is already installed. This repo does not ship it. */
export async function detectTailscale(): Promise<boolean> {
  const names = Object.keys(networkInterfaces());
  if (tailscaleInterfacePresent(names)) return true;
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile("tailscale", ["ip", "-4"], { timeout: 800 }, (error, out) => {
        if (error) reject(error);
        else resolve(out);
      });
    });
    return stdout.split(/\s+/).some((part) => /^\d+\.\d+\.\d+\.\d+$/.test(part));
  } catch {
    return false;
  }
}

export function localAddresses(): { lan: string[]; tailscale: string[] } {
  const lan: string[] = [];
  const tailscale: string[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.internal || address.family !== "IPv4") continue;
      if (/^tailscale/i.test(name)) tailscale.push(address.address);
      else lan.push(address.address);
    }
  }
  return { lan, tailscale };
}

export function looksLikeCode(value: string): boolean {
  return value.length === 8 && [...value].every((char) => CODE_ALPHABET.includes(char));
}

/** Menu label. Two services with the same name stay distinct. */
export function peerChoiceValue(peer: RemotePeer, peers: readonly RemotePeer[]): string {
  const same = peers.filter((item) => item.name === peer.name);
  if (same.length < 2) return peer.name;
  return `${peer.name} (${peer.publicKey.slice(-4)})`;
}

export type DialResolution =
  | { kind: "paired"; publicKey: string; peer: RemotePeer | null; relayName: string }
  | { kind: "open"; peers: RemotePeer[] }
  | { kind: "introduce"; code: string; peers: RemotePeer[] }
  | { kind: "need-code"; name: string }
  | { kind: "unknown"; target: string };

/**
 * A saved name connects with no code. A service seen on the network or VPN
 * needs the code once. A typed code is tried against every visible service,
 * then the relay.
 */
export function resolveDial(options: {
  target: string;
  code?: string;
  pairings: Record<string, Pairing>;
  peers: readonly RemotePeer[];
}): DialResolution {
  const target = options.target.trim();
  const saved = options.pairings[target];
  if (saved) {
    return {
      kind: "paired",
      publicKey: saved.publicKey,
      peer: options.peers.find((peer) => peer.publicKey === saved.publicKey) ?? null,
      relayName: target,
    };
  }

  const named = peersMatchingChoice(target, options.peers);
  if (named.length > 0) {
    if (named.length === 1) {
      const existing = Object.entries(options.pairings).find(([, pairing]) => pairing.publicKey === named[0]!.publicKey);
      if (existing) {
        return { kind: "paired", publicKey: named[0]!.publicKey, peer: named[0]!, relayName: existing[0] };
      }
    }
    if (named.every((peer) => peer.acceptAll)) return { kind: "open", peers: named };
    const code = options.code?.trim();
    if (!code) {
      const name = named.length === 1 ? peerChoiceValue(named[0]!, options.peers) : target;
      return { kind: "need-code", name };
    }
    return { kind: "introduce", code, peers: named };
  }

  const explicit = options.code?.trim();
  if (explicit) return { kind: "introduce", code: explicit, peers: [...options.peers] };
  if (looksLikeCode(target)) return { kind: "introduce", code: target, peers: [...options.peers] };
  return { kind: "unknown", target };
}

function peersMatchingChoice(choice: string, peers: readonly RemotePeer[]): RemotePeer[] {
  const marked = /^(.+) \(([A-Za-z0-9_-]{4})\)$/.exec(choice);
  if (marked?.[1] && marked[2]) {
    return peers.filter((peer) => peer.name === marked[1] && peer.publicKey.endsWith(marked[2]!));
  }
  return peers.filter((peer) => peer.name === choice || peer.publicKey === choice);
}

/**
 * LAN, then an existing VPN (Tailscale), then the configured relay.
 * `target` is a saved short name, a discovered service name, or a one-time code.
 * `code` is set only for the first send to a service that is not paired yet.
 */
export async function connectToPeer(options: {
  target: string;
  code?: string;
  config: TeleportConfig;
  identity: Identity;
  peers: readonly RemotePeer[];
  ourName: string;
}): Promise<ConnectedPeer> {
  const resolution = resolveDial({
    target: options.target,
    code: options.code,
    pairings: options.config.pairings,
    peers: options.peers,
  });
  if (resolution.kind === "need-code") {
    throw new Error(`The first teleport to ${resolution.name} needs its one-time code. After that, the code is not asked again.`);
  }
  if (resolution.kind === "unknown") {
    throw new Error(`No pi-teleport service named ${resolution.target} is visible on this network or VPN.`);
  }
  if (resolution.kind === "paired") {
    const opened = await openPeer({
      peer: resolution.peer,
      viaCode: false,
      expectPub: resolution.publicKey,
      relayRoute: { name: resolution.relayName },
      config: options.config,
      identity: options.identity,
      ourName: options.ourName,
    });
    if (!opened) {
      const state = resolution.peer ? "not reachable" : "not visible";
      throw new Error(`${resolution.relayName} is paired, but its pi-teleport service is ${state} on this network or VPN.`);
    }
    return opened;
  }
  if (resolution.kind === "open") {
    let other: Error | undefined;
    for (const peer of resolution.peers) {
      try {
        const opened = await openPeer({
          peer,
          viaCode: false,
          expectPub: peer.publicKey,
          relayRoute: { name: peer.name },
          config: options.config,
          identity: options.identity,
          ourName: options.ourName,
        });
        if (opened) return opened;
      } catch (error) {
        other = error as Error;
      }
    }
    throw other ?? new Error("That pi-teleport service is not reachable on this network or VPN.");
  }

  let mismatch: Error | undefined;
  let other: Error | undefined;
  for (const peer of resolution.peers) {
    try {
      const opened = await openPeer({
        peer,
        viaCode: true,
        code: resolution.code,
        expectPub: peer.publicKey,
        relayRoute: null,
        config: options.config,
        identity: options.identity,
        ourName: options.ourName,
      });
      if (opened) return opened;
    } catch (error) {
      const err = error as Error;
      if (/one-time code does not match|rejected sender|pairing code/.test(err.message)) mismatch = err;
      else other = err;
    }
  }
  try {
    const opened = await openPeer({
      peer: null,
      viaCode: true,
      code: resolution.code,
      relayRoute: { code: resolution.code },
      config: options.config,
      identity: options.identity,
      ourName: options.ourName,
    });
    if (opened) return opened;
  } catch (error) {
    other = error as Error;
  }
  if (mismatch) throw mismatch;
  if (resolution.peers.length > 0) {
    throw other ?? new Error("That pi-teleport service is not reachable on this network or VPN.");
  }
  throw other ?? new Error("No pi-teleport service is visible on this network or VPN.");
}

async function openPeer(options: {
  peer: RemotePeer | null;
  viaCode: boolean;
  code?: string;
  expectPub?: string;
  relayRoute: { name?: string; code?: string } | null;
  config: TeleportConfig;
  identity: Identity;
  ourName: string;
}): Promise<ConnectedPeer | null> {
  const port = options.peer?.port ?? options.config.listenPort;
  const lanHost = options.peer ? await firstOpen(options.peer.lan, port, 500) : null;
  const tailscaleDetected = await detectTailscale();
  const tailscaleHost = options.peer && tailscaleDetected ? await firstOpen(options.peer.tailscale, port, 1200) : null;
  let relayOk = false;
  if (options.relayRoute && options.config.relay && !lanHost && !tailscaleHost) {
    const relay = parseHostPort(options.config.relay, RELAY_PORT);
    relayOk = await canConnect(relay.host, relay.port, 700);
  }
  const transport = selectTransport({
    lan: Boolean(lanHost),
    tailscaleDetected,
    tailscale: Boolean(tailscaleHost),
    relay: relayOk,
  });
  if (!transport) return null;
  const hello = {
    name: options.ourName,
    code: options.viaCode ? options.code : undefined,
    expectPub: options.expectPub,
  };
  if (transport === "relay") {
    if (!options.config.relay || !options.relayRoute) return null;
    const relay = parseHostPort(options.config.relay, RELAY_PORT);
    const opened = await dialRelay(relay.host, relay.port, options.identity, hello, options.relayRoute);
    return { ...opened, transport, viaCode: options.viaCode, publicKey: opened.hello.staticPub };
  }
  const host = transport === "lan" ? lanHost : tailscaleHost;
  if (!host) return null;
  const opened = await dialDirect(host, port, options.identity, hello);
  return { ...opened, transport, viaCode: options.viaCode, publicKey: opened.hello.staticPub };
}

async function firstOpen(hosts: readonly string[], port: number, timeoutMs: number): Promise<string | null> {
  for (const host of hosts) {
    if (await canConnect(host, port, timeoutMs)) return host;
  }
  return null;
}

export async function dialDirect(
  host: string,
  port: number,
  identity: Identity,
  hello: { name: string; code?: string; expectPub?: string },
): Promise<{ link: PeerLink; hello: Hello }> {
  const socket = connectTcp({ host, port, timeout: 8000 });
  await once(socket, "connect");
  const result = await handshakeSender(socket, identity, hello);
  return { link: result.link, hello: result.peer };
}

export async function dialRelay(
  host: string,
  port: number,
  identity: Identity,
  hello: { name: string; code?: string; expectPub?: string },
  route: { name?: string; code?: string },
): Promise<{ link: PeerLink; hello: Hello }> {
  const socket = connectTcp({ host, port, timeout: 8000 });
  await once(socket, "connect");
  writeLine(socket, { t: "connect", ...route });
  const line = await readLine(socket);
  const message = JSON.parse(line) as { t?: string; message?: string };
  if (message.t === "error") throw new Error(message.message ?? "relay refused the connection");
  if (message.t !== "bridge") throw new Error("relay did not bridge");
  const result = await handshakeSender(socket, identity, hello);
  return { link: result.link, hello: result.peer };
}

export function connectSocket(host: string, port: number): Socket {
  return connectTcp({ host, port });
}

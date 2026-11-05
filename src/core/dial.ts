import { execFile } from "node:child_process";
import { once } from "node:events";
import { connect as connectTcp, type Socket } from "node:net";
import { networkInterfaces } from "node:os";

import { RELAY_PORT } from "./constants.ts";
import { parseHostPort, type TeleportConfig } from "./config.ts";
import type { Identity } from "./crypto.ts";
import { handshakeSender, type Hello, type PeerLink } from "./link.ts";
import { readLine, writeLine } from "./lines.ts";
import { selectTransport, tailscaleInterfacePresent, type TransportKind } from "./transport.ts";

export interface RemotePeer {
  name: string;
  publicKey: string;
  port: number;
  code?: string;
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

/**
 * LAN, then Tailscale when this machine has it, then the configured relay.
 * `target` is a saved short name or a one-time code.
 */
export async function connectToPeer(options: {
  target: string;
  config: TeleportConfig;
  identity: Identity;
  peers: readonly RemotePeer[];
  ourName: string;
}): Promise<ConnectedPeer> {
  const pairing = options.config.pairings[options.target];
  const viaCode = !pairing;
  const peer = pairing
    ? options.peers.find((item) => item.publicKey === pairing.publicKey)
    : options.peers.find((item) => item.code === options.target);
  const port = peer?.port ?? options.config.listenPort;
  const lanHost = peer ? await firstOpen(peer.lan, port) : null;
  const tailscaleDetected = await detectTailscale();
  const tailscaleHost = peer && tailscaleDetected ? await firstOpen(peer.tailscale, port) : null;
  let relayOk = false;
  if (options.config.relay && !lanHost && !tailscaleHost) {
    const relay = parseHostPort(options.config.relay, RELAY_PORT);
    relayOk = await canConnect(relay.host, relay.port, 700);
  }
  const transport = selectTransport({
    lan: Boolean(lanHost),
    tailscaleDetected,
    tailscale: Boolean(tailscaleHost),
    relay: relayOk,
  });
  if (!transport) {
    throw new Error("No route to that computer. Check the listener, the same LAN, Tailscale, or the relay.");
  }
  const hello = {
    name: options.ourName,
    code: viaCode ? options.target : undefined,
    expectPub: pairing?.publicKey ?? peer?.publicKey,
  };
  if (transport === "relay") {
    if (!options.config.relay) throw new Error("no relay is configured");
    const relay = parseHostPort(options.config.relay, RELAY_PORT);
    const opened = await dialRelay(relay.host, relay.port, options.identity, hello, viaCode
      ? { code: options.target }
      : { name: options.target });
    return { ...opened, transport, viaCode, publicKey: opened.hello.staticPub };
  }
  const host = transport === "lan" ? lanHost : tailscaleHost;
  if (!host) throw new Error("that computer is not reachable");
  const opened = await dialDirect(host, port, options.identity, hello);
  return { ...opened, transport, viaCode, publicKey: opened.hello.staticPub };
}

async function firstOpen(hosts: readonly string[], port: number): Promise<string | null> {
  for (const host of hosts) {
    if (await canConnect(host, port)) return host;
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

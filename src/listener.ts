import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTcp, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import { configRoot, currentOs, loadConfig, loadIdentity, parseHostPort, saveConfig, type TeleportConfig } from "./core/config.ts";
import { RELAY_PORT } from "./core/constants.ts";
import { makeCode, type Identity } from "./core/crypto.ts";
import { localAddresses, type RemotePeer } from "./core/dial.ts";
import {
  beaconDestinations,
  beaconPayload,
  localBroadcasts,
  PEER_TTL_MS,
  preferSource,
  vpnProbeHosts,
} from "./core/discover.ts";
import { launchPi } from "./core/launch.ts";
import { handshakeListener } from "./core/link.ts";
import { readLine, writeLine } from "./core/lines.ts";
import { connect as connectTcp } from "node:net";
import { once } from "node:events";
import { lstat } from "node:fs/promises";
import { receiveSession } from "./core/transfer.ts";

export interface PendingLaunch {
  sessionFile: string;
  cwd: string;
  command: string;
}

export interface ListenerHandle {
  code: string;
  port: number;
  controlPort: number;
  beaconPort: number;
  close: () => Promise<void>;
}

export async function startListener(options: { root?: string; home?: string } = {}): Promise<ListenerHandle> {
  const home = options.home ?? homedir();
  const root = options.root ?? configRoot(home);
  await mkdir(root, { recursive: true });
  const identity = await loadIdentity(root);
  let config = await loadConfig(root);
  const code = makeCode();
  await writeFile(join(root, "code"), `${code}\n`, { mode: 0o600 });
  await chmod(join(root, "code"), 0o600).catch(() => undefined);
  const peers = new Map<string, RemotePeer>();
  let pending: PendingLaunch | null = null;
  const waiters: ((launch: PendingLaunch) => void)[] = [];
  let stopped = false;

  const known = (publicKey: string) => Object.values(config.pairings).some((item) => item.publicKey === publicKey);

  async function serve(socket: Socket): Promise<void> {
    config = await loadConfig(root);
    const accepted = await handshakeListener(socket, identity, {
      name: config.name,
      os: currentOs(),
      home,
      code,
    }, known);
    if (accepted.code) await rememberSender(accepted.peer.name, accepted.peer.staticPub);
    await receiveSession(accepted.link, {
      stateRoot: join(root, "incoming"),
      sessionsRoot: process.env.PI_CODING_AGENT_DIR
        ? join(process.env.PI_CODING_AGENT_DIR, "sessions")
        : join(home, ".pi", "agent", "sessions"),
      home,
      os: currentOs(),
      exists: async (path) => {
        try {
          await lstat(path);
          return true;
        } catch {
          return false;
        }
      },
      launch: async (sessionFile, cwd) => {
        const result = launchPi(sessionFile, cwd);
        const line = result.started
          ? `pi session started: ${result.command}`
          : `${result.note}\n${result.command}`;
        console.log(line);
        if (!result.started) {
          pending = { sessionFile, cwd, command: result.command };
          for (const waiter of waiters.splice(0)) waiter(pending);
        }
        return { started: result.started, command: result.command };
      },
    });
  }

  async function rememberSender(name: string, publicKey: string): Promise<void> {
    if (!name || config.pairings[name]?.publicKey === publicKey) {
      if (name && !config.pairings[name]) {
        config.pairings[name] = { publicKey };
        await saveConfig(config, root);
        console.log(`saved ${name} after one-time code`);
      }
      return;
    }
    if (!config.pairings[name]) {
      config.pairings[name] = { publicKey };
      await saveConfig(config, root);
      console.log(`saved ${name} after one-time code`);
      return;
    }
    console.log(`one-time sender ${name} has a different key than the saved pairing; left the saved key in place`);
  }

  const tcp: Server = createTcp((socket) => {
    void serve(socket).catch((error: Error) => {
      if (error.message !== "connection closed" && error.message !== "rejected sender") {
        console.error(error.message);
      }
      socket.destroy();
    });
  });
  await listen(tcp, config.listenPort);

  const control = createHttp(async (request, response) => {
    try {
      await route(request, response);
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: (error as Error).message }));
    }
  });
  await listen(control, config.controlPort, "127.0.0.1");

  const beacon = await bindBeacon(config.beaconPort, (message, from) => {
    if (message.pub === identity.publicKey || !message.pub) return;
    const onVpn = (message.ts ?? []).includes(from);
    peers.set(message.pub, {
      name: message.name ?? "pi",
      publicKey: message.pub,
      port: message.port ?? boundPort(tcp),
      lan: onVpn ? [...(message.lan ?? [])] : preferSource(from, message.lan ?? []),
      tailscale: onVpn ? preferSource(from, message.ts ?? []) : [...(message.ts ?? [])],
      lastSeen: Date.now(),
    });
  });
  const stop = new AbortController();
  let vpnHosts: string[] = [];
  let announceCount = 0;
  const announce = async () => {
    if (stopped) return;
    if (announceCount % 8 === 0) vpnHosts = await vpnProbeHosts(stop.signal);
    announceCount += 1;
    if (stopped) return;
    const addresses = localAddresses();
    const payload = beaconPayload({
      v: 1,
      name: config.name,
      pub: identity.publicKey,
      port: boundPort(tcp),
      lan: addresses.lan,
      ts: addresses.tailscale,
    });
    const port = boundUdp(beacon);
    beacon.setBroadcast(true);
    for (const host of beaconDestinations(localBroadcasts(), vpnHosts)) {
      try {
        beacon.send(payload, port, host, () => undefined);
      } catch {
        // The socket can close while an announce is still in flight.
      }
    }
  };
  void announce();
  const beaconTimer = setInterval(() => void announce(), 2000);
  beaconTimer.unref?.();

  const relayAbort = new AbortController();
  if (config.relay) void relayLoop(config, identity, code, relayAbort.signal, serve);

  console.log(`pi-teleport listener "${config.name}"`);
  console.log(`one-time code: ${code}`);
  console.log(`port ${boundPort(tcp)}, control 127.0.0.1:${boundPort(control)}`);
  if (config.relay) console.log(`relay ${config.relay}`);

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/status") {
      send(response, 200, {
        name: config.name,
        code,
        publicKey: identity.publicKey,
        os: currentOs(),
        home,
        relay: config.relay ?? null,
        listenPort: config.listenPort,
        pairings: Object.keys(config.pairings),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/peers") {
      const now = Date.now();
      send(response, 200, [...peers.values()].filter((peer) => now - peer.lastSeen <= PEER_TTL_MS));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/pairings") {
      const body = JSON.parse(await readBody(request)) as { name?: string; publicKey?: string };
      if (!body.name || !body.publicKey) {
        send(response, 400, { error: "name and publicKey are required" });
        return;
      }
      const existing = config.pairings[body.name];
      if (existing && existing.publicKey !== body.publicKey) {
        send(response, 409, { error: `${body.name} is already paired with a different key` });
        return;
      }
      config.pairings[body.name] = { publicKey: body.publicKey };
      await saveConfig(config, root);
      send(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/launch/wait") {
      if (pending) {
        const launch = pending;
        pending = null;
        send(response, 200, launch);
        return;
      }
      const launch = await new Promise<PendingLaunch | null>((resolve) => {
        const timer = setTimeout(() => {
          const index = waiters.indexOf(onLaunch);
          if (index >= 0) waiters.splice(index, 1);
          resolve(null);
        }, 30000);
        const onLaunch = (value: PendingLaunch) => {
          clearTimeout(timer);
          pending = null;
          resolve(value);
        };
        waiters.push(onLaunch);
      });
      if (!launch) {
        response.writeHead(204);
        response.end();
        return;
      }
      send(response, 200, launch);
      return;
    }
    response.writeHead(404);
    response.end();
  }

  return {
    code,
    port: boundPort(tcp),
    controlPort: boundPort(control),
    beaconPort: boundUdp(beacon),
    close: async () => {
      if (stopped) return;
      stopped = true;
      stop.abort();
      relayAbort.abort();
      clearInterval(beaconTimer);
      beacon.close();
      await Promise.all([closeServer(tcp), closeServer(control)]);
    },
  };
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function listen(server: Server | ReturnType<typeof createHttp>, port: number, host?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host ?? "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function boundPort(server: Server | ReturnType<typeof createHttp>): number {
  const address = server.address();
  return address && typeof address === "object" ? address.port : 0;
}

function boundUdp(socket: UdpSocket): number {
  const address = socket.address();
  return typeof address === "object" ? address.port : 0;
}

function closeServer(server: Server | ReturnType<typeof createHttp>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

interface Beacon {
  v?: number;
  name?: string;
  pub?: string;
  port?: number;
  code?: string;
  lan?: string[];
  ts?: string[];
}

async function bindBeacon(port: number, onBeacon: (message: Beacon, from: string) => void): Promise<UdpSocket> {
  const socket = createSocket({ type: "udp4", reuseAddr: true });
  socket.on("message", (msg, info) => {
    try {
      onBeacon(JSON.parse(msg.toString("utf8")) as Beacon, info.address);
    } catch {
      // Ignore malformed beacons.
    }
  });
  socket.on("error", (error) => console.error(`beacon: ${error.message}`));
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, () => {
      socket.off("error", reject);
      try {
        socket.setBroadcast(true);
      } catch {
        // Some platforms reject broadcast until the first send.
      }
      resolve();
    });
  });
  return socket;
}

async function relayLoop(
  config: TeleportConfig,
  identity: Identity,
  code: string,
  signal: AbortSignal,
  serve: (socket: Socket) => Promise<void>,
): Promise<void> {
  const relay = parseHostPort(config.relay ?? "", RELAY_PORT);
  while (!signal.aborted) {
    try {
      const socket = connectTcp(relay.port, relay.host);
      await once(socket, "connect");
      writeLine(socket, { t: "register", name: config.name, pubkey: identity.publicKey, code });
      const registered = JSON.parse(await readLine(socket)) as { t?: string };
      if (registered.t !== "registered") throw new Error("relay refused registration");
      const bridged = JSON.parse(await readLine(socket)) as { t?: string };
      if (bridged.t !== "bridge") throw new Error("relay closed before a transfer");
      await serve(socket);
    } catch (error) {
      if (signal.aborted) return;
      console.error(`relay: ${(error as Error).message}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

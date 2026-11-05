#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { configRoot, loadConfig, parseHostPort, saveConfig } from "./core/config.ts";
import { RELAY_PORT } from "./core/constants.ts";
import { startListener } from "./listener.ts";
import { startRelay } from "./relay.ts";

const HELP = `pi-teleport

  listen                 run the background listener (prints a one-time code)
  relay [--listen host:port]
                         run the relay on a machine you control
  code                   print the listener's current one-time code
  name <short-name>      set this computer's paired name
  relay-set <host:port>  remember the relay address
  save <name> <pubkey>   save a one-time peer as a short name
  peers                  list computers the listener can see
  status                 show this computer's name, key, and relay
  attach                 start the received pi session in this terminal
`;

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const root = configRoot();
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(HELP);
    return;
  }
  if (command === "listen") {
    await startListener({ root, home: homedir() });
    await new Promise(() => undefined);
    return;
  }
  if (command === "relay") {
    const spec = rest[0] === "--listen" ? rest[1] : rest[0];
    const parsed = spec ? parseHostPort(spec, RELAY_PORT) : { host: "0.0.0.0", port: RELAY_PORT };
    const server = startRelay(parsed.port, parsed.host);
    if (!server.listening) await once(server, "listening");
    console.log(`pi-teleport relay on ${parsed.host}:${parsed.port}`);
    await new Promise(() => undefined);
    return;
  }
  if (command === "code") {
    console.log((await readFile(join(root, "code"), "utf8")).trim());
    return;
  }
  if (command === "name") {
    const name = rest[0]?.trim();
    if (!name) throw new Error("usage: pi-teleport name <short-name>");
    const config = await loadConfig(root);
    config.name = name;
    await saveConfig(config, root);
    console.log(`this computer is ${name}`);
    return;
  }
  if (command === "relay-set") {
    const relay = rest[0]?.trim();
    if (!relay) throw new Error("usage: pi-teleport relay-set <host:port>");
    parseHostPort(relay, RELAY_PORT);
    const config = await loadConfig(root);
    config.relay = relay;
    await saveConfig(config, root);
    console.log(`relay set to ${relay}`);
    return;
  }
  if (command === "save") {
    const name = rest[0]?.trim();
    const publicKey = rest[1]?.trim();
    if (!name || !publicKey) throw new Error("usage: pi-teleport save <name> <pubkey>");
    const config = await loadConfig(root);
    config.pairings[name] = { publicKey };
    await saveConfig(config, root);
    console.log(`saved ${name}`);
    return;
  }
  if (command === "status" || command === "peers") {
    const config = await loadConfig(root);
    try {
      const body = await control(config.controlPort, command === "peers" ? "/v1/peers" : "/v1/status");
      console.log(JSON.stringify(body, null, 2));
    } catch (error) {
      if (command === "peers") throw error;
      console.log(JSON.stringify({ ...config, listener: "down", hint: (error as Error).message }, null, 2));
    }
    return;
  }
  if (command === "attach") {
    const config = await loadConfig(root);
    for (;;) {
      const launch = await control(config.controlPort, "/v1/launch/wait").catch(() => null);
      if (!launch || typeof launch !== "object") {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      const record = launch as { sessionFile?: string; cwd?: string };
      if (!record.sessionFile || !record.cwd) continue;
      const child = spawn("pi", ["--session", record.sessionFile], { cwd: record.cwd, stdio: "inherit" });
      const code = await once(child, "exit");
      process.exitCode = typeof code[0] === "number" ? code[0] : 1;
      return;
    }
  }
  throw new Error(`unknown command ${command}\n\n${HELP}`);
}

function control(port: number, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        if (res.statusCode === 204) {
          resolve(null);
          return;
        }
        const text = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 500) >= 300) {
          reject(new Error(text || `listener returned ${res.statusCode}`));
          return;
        }
        resolve(text ? JSON.parse(text) : null);
      });
    });
    req.on("error", () => reject(new Error("the listener is not running")));
    req.end();
  });
}

const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (entry === import.meta.url || entry === pathToFileURL(fileURLToPath(import.meta.url)).href) {
  main(process.argv.slice(2)).catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

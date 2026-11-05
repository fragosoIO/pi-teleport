#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { request } from "node:http";
import { homedir } from "node:os";
import { stdin as input, stdout as output } from "node:process";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { configRoot, configuredProjects, loadConfig, parseHostPort, parsePairingMode, parseYesNo, resolveProjectsDir, saveConfig, SUGGESTED_PROJECTS } from "./core/config.ts";
import { RELAY_PORT } from "./core/constants.ts";
import { installUserService, uninstallUserService, userServiceStatus } from "./core/service.ts";
import { startListener } from "./listener.ts";
import { startRelay } from "./relay.ts";

const HELP = `pi-teleport

  setup                  choose the projects folder, pairing, and whether to start the service
  listen                 run the listener in the foreground (prints a one-time code)
  service install        run the listener as a user service on this computer
  service uninstall      stop and remove that service
  service status         show the user service
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
  if (command === "setup") {
    if (rest.length > 0) throw new Error("pi-teleport setup takes no arguments");
    if (!input.isTTY) throw new Error("pi-teleport setup must be run in a terminal");
    const config = await loadConfig(root);
    const dir = await askProjects();
    const requireCode = await askPairing();
    const start = await askService();
    config.projects = dir;
    config.requireCode = requireCode;
    await saveConfig(config, root);
    console.log(`projects folder is ${dir}`);
    console.log(requireCode ? "a one-time code is required" : "teleports are accepted from any computer");
    if (!start) {
      console.log("the service was not started");
      return;
    }
    await installService(root, requireCode);
    return;
  }
  if (command === "listen") {
    configuredProjects(await loadConfig(root));
    await startListener({ root, home: homedir() });
    await new Promise(() => undefined);
    return;
  }
  if (command === "service") {
    const action = rest[0] ?? "status";
    if (action === "install") {
      const config = await loadConfig(root);
      configuredProjects(config);
      await installService(root, config.requireCode !== false);
      return;
    }
    if (action === "uninstall") {
      await uninstallUserService(homedir());
      console.log("pi-teleport service removed");
      return;
    }
    if (action === "status") {
      console.log(await userServiceStatus());
      return;
    }
    throw new Error("usage: pi-teleport service install|uninstall|status");
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

async function askProjects(): Promise<string> {
  for (;;) {
    const given = await ask(`Projects folder [${SUGGESTED_PROJECTS}]: `);
    try {
      return await resolveProjectsDir(given || SUGGESTED_PROJECTS);
    } catch (error) {
      console.log((error as Error).message);
    }
  }
}

async function askPairing(): Promise<boolean> {
  for (;;) {
    const given = await ask("Require a one-time code, or accept all? [code/all]: ");
    try {
      return parsePairingMode(given) === "code";
    } catch (error) {
      console.log((error as Error).message);
    }
  }
}

async function askService(): Promise<boolean> {
  for (;;) {
    const given = await ask("Start the service? [y/n]: ");
    try {
      return parseYesNo(given);
    } catch (error) {
      console.log((error as Error).message);
    }
  }
}

async function installService(root: string, requireCode: boolean): Promise<void> {
  const started = Date.now();
  const result = await installUserService(homedir());
  console.log(`pi-teleport service installed (${result.unit})`);
  if (!result.linger) {
    console.log("The service runs while you are logged in. To keep it after logout: loginctl enable-linger");
  }
  if (!requireCode) return;
  const pairingCode = await readCode(root, started);
  console.log(pairingCode ? `one-time code: ${pairingCode}` : "run: pi-teleport code");
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function readCode(root: string, notBefore: number): Promise<string | null> {
  const path = join(root, "code");
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      const info = await stat(path);
      if (info.mtimeMs >= notBefore) return (await readFile(path, "utf8")).trim();
    } catch {
      // The listener writes the code after it starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
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

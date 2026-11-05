import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { BEACON_PORT, CONTROL_PORT, LAN_PORT } from "./constants.ts";
import { createIdentity, type Identity } from "./crypto.ts";
import type { OsName } from "./paths.ts";

export interface Pairing {
  publicKey: string;
}

export interface TeleportConfig {
  name: string;
  listenPort: number;
  beaconPort: number;
  controlPort: number;
  relay?: string;
  pairings: Record<string, Pairing>;
}

export function configRoot(home = homedir()): string {
  return join(home, ".pi-teleport");
}

export function currentOs(): OsName {
  if (process.platform === "win32" || process.platform === "darwin" || process.platform === "linux") return process.platform;
  return "linux";
}

export function defaultName(): string {
  return hostname().split(".")[0].toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32) || "pi";
}

export function defaultConfig(): TeleportConfig {
  return {
    name: defaultName(),
    listenPort: LAN_PORT,
    beaconPort: BEACON_PORT,
    controlPort: CONTROL_PORT,
    pairings: {},
  };
}

export async function loadConfig(root = configRoot()): Promise<TeleportConfig> {
  try {
    const raw = JSON.parse(await readFile(join(root, "config.json"), "utf8")) as Partial<TeleportConfig>;
    return { ...defaultConfig(), ...raw, pairings: raw.pairings ?? {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig();
    throw error;
  }
}

export async function saveConfig(config: TeleportConfig, root = configRoot()): Promise<void> {
  await mkdir(root, { recursive: true });
  const path = join(root, "config.json");
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

export async function loadIdentity(root = configRoot()): Promise<Identity> {
  const path = join(root, "identity.json");
  try {
    return JSON.parse(await readFile(path, "utf8")) as Identity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const identity = createIdentity();
    await mkdir(root, { recursive: true });
    await writeFile(path, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
    await chmod(path, 0o600).catch(() => undefined);
    return identity;
  }
}

export function parseHostPort(value: string, fallbackPort: number): { host: string; port: number } {
  const trimmed = value.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon <= 0) return { host: trimmed, port: fallbackPort };
  const port = Number(trimmed.slice(colon + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad port in ${value}`);
  return { host: trimmed.slice(0, colon), port };
}

import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, parse, resolve } from "node:path";

import { BEACON_PORT, CONTROL_PORT, LAN_PORT } from "./constants.ts";
import { createIdentity, type Identity } from "./crypto.ts";
import { resumeModelFromConfig, type ResumeModel } from "./models.ts";
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
  /** Absolute folder that receives teleported projects on this computer. */
  projects?: string;
  /** When false, any reachable computer may teleport here without a one-time code. */
  requireCode?: boolean;
  /** Model pi uses when a session resumes on this computer. */
  model?: ResumeModel;
  pairings: Record<string, Pairing>;
}

export function configRoot(home = homedir()): string {
  return join(home, ".pi-teleport");
}

/** Shown in setup. Enter accepts it, and the folder is created if it is missing. */
export const SUGGESTED_PROJECTS = "~/.pi-teleport/projects";

export function defaultProjectsDir(home = homedir()): string {
  return join(configRoot(home), "projects");
}

export function currentOs(): OsName {
  if (process.platform === "win32" || process.platform === "darwin" || process.platform === "linux") return process.platform;
  return "linux";
}

export const SETUP_HINT = "run pi-teleport setup before using teleport";

/** True after setup has chosen a projects folder and a pairing rule. */
export function setupComplete(config: TeleportConfig): boolean {
  return Boolean(config.projects?.trim()) && typeof config.requireCode === "boolean";
}

/** The projects folder chosen by `pi-teleport setup`, or an error when setup has not been run. */
export function configuredProjects(config: TeleportConfig): string {
  if (!setupComplete(config)) throw new Error(SETUP_HINT);
  return config.projects!.trim();
}

/** `code` requires a one-time code. `all` accepts any computer that can reach this service. */
export function parsePairingMode(input: string): "code" | "all" {
  const value = input.trim().toLowerCase();
  if (value === "code" || value === "one-time" || value === "onetime") return "code";
  if (value === "all" || value === "accept" || value === "accept all") return "all";
  throw new Error("answer code or all");
}

export function parseYesNo(input: string): boolean {
  const value = input.trim().toLowerCase();
  if (value === "y" || value === "yes") return true;
  if (value === "n" || value === "no") return false;
  throw new Error("answer y or n");
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
    const model = resumeModelFromConfig(raw.model);
    return { ...defaultConfig(), ...raw, pairings: raw.pairings ?? {}, model };
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

/** Expand `~` and resolve to an absolute folder. A drive root is refused. */
export function normalizeProjectsDir(input: string, home = homedir()): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("a projects folder is required");
  let expanded = trimmed;
  if (expanded === "~") expanded = home;
  else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) expanded = join(home, expanded.slice(2));
  const absolute = resolve(expanded);
  if (absolute === parse(absolute).root) throw new Error("projects folder cannot be a drive root");
  return absolute;
}

/**
 * Resolve a projects folder.
 * The suggested default is created when it is missing. Any other path must already be a folder.
 */
export async function resolveProjectsDir(input: string, home = homedir()): Promise<string> {
  const dir = normalizeProjectsDir(input, home);
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) throw new Error(`not a folder: ${dir}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (dir === defaultProjectsDir(home)) {
        await mkdir(dir, { recursive: true });
        return dir;
      }
      throw new Error(`no such folder: ${dir}`);
    }
    throw error;
  }
  return dir;
}

export function parseHostPort(value: string, fallbackPort: number): { host: string; port: number } {
  const trimmed = value.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon <= 0) return { host: trimmed, port: fallbackPort };
  const port = Number(trimmed.slice(colon + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad port in ${value}`);
  return { host: trimmed.slice(0, colon), port };
}

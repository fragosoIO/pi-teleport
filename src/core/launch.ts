import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ATTACH = "pi-teleport attach";
const GRAPHICAL_KEYS = ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_CURRENT_DESKTOP"] as const;

export interface LaunchResult {
  started: boolean;
  /** One line. When pi was not started, this is `pi-teleport attach`. */
  command: string;
  note: string;
}

export interface LaunchRun {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Wait for a short multiplexer command. A terminal stays running. */
  wait: boolean;
}

export interface LaunchPlan {
  started: boolean;
  command: string;
  note: string;
  run?: LaunchRun;
}

export interface LaunchContext {
  sessionFile: string;
  cwd: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  have: (command: string) => boolean;
  piPath: string | null;
  tmuxSession: string | null;
  zellijSession: string | null;
  wezterm: boolean;
  launchDisabled: boolean;
}

/**
 * Start a new pi process that resumes the transferred session file.
 * This does not attach to a pi process that is already running.
 * The listener often has no display of its own, so the plan borrows the
 * logged-in graphical session, or an attached tmux or zellij session.
 */
export function launchPi(sessionFile: string, cwd: string): LaunchResult {
  try {
    const plan = planFromProcess(sessionFile, cwd);
    if (!plan.run) return { started: false, command: plan.command, note: plan.note };
    const ok = plan.run.wait ? runAndWait(plan.run) : runDetached(plan.run);
    if (!ok) {
      return {
        started: false,
        command: ATTACH,
        note: "could not open a terminal; run pi-teleport attach in a terminal on that computer",
      };
    }
    return { started: true, command: plan.command, note: plan.note };
  } catch {
    return {
      started: false,
      command: ATTACH,
      note: "could not open a terminal; run pi-teleport attach in a terminal on that computer",
    };
  }
}

export function selectLaunch(input: LaunchContext): LaunchPlan {
  if (input.launchDisabled) return { started: false, command: ATTACH, note: "launch disabled" };
  if (!input.piPath) return { started: false, command: ATTACH, note: "pi is not installed on this computer" };

  const command = `pi --session ${quote(input.sessionFile, input.platform)}`;
  const terminal = findTerminal(input);
  if (terminal) {
    return {
      started: true,
      command,
      note: terminal.command,
      run: { file: terminal.command, args: terminal.args, env: input.env, cwd: input.cwd, wait: false },
    };
  }
  if (input.wezterm && input.have("wezterm")) {
    return {
      started: true,
      command,
      note: "wezterm",
      run: {
        file: "wezterm",
        args: ["cli", "spawn", "--cwd", input.cwd, "--", input.piPath, "--session", input.sessionFile],
        env: input.env,
        cwd: input.cwd,
        wait: true,
      },
    };
  }
  if (input.tmuxSession) {
    return {
      started: true,
      command,
      note: "tmux",
      run: {
        file: "tmux",
        args: ["new-window", "-t", input.tmuxSession, "-c", input.cwd, input.piPath, "--session", input.sessionFile],
        env: input.env,
        cwd: input.cwd,
        wait: true,
      },
    };
  }
  if (input.zellijSession) {
    return {
      started: true,
      command,
      note: "zellij",
      run: {
        file: "zellij",
        args: ["--session", input.zellijSession, "action", "new-tab", "--cwd", input.cwd, "--", input.piPath, "--session", input.sessionFile],
        env: input.env,
        cwd: input.cwd,
        wait: true,
      },
    };
  }
  return {
    started: false,
    command: ATTACH,
    note: "no terminal found; run pi-teleport attach in a terminal on that computer",
  };
}

/** `~/.pi/agent/bin/pi` when the managed install is present, otherwise `pi` on PATH. */
export function findPiBinary(home: string, env: NodeJS.ProcessEnv): string | null {
  const candidates = [join(home, ".pi", "agent", "bin", "pi"), join(home, ".local", "bin", "pi")];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next install location.
    }
  }
  const path = env.PATH ?? "";
  return path.split(path.includes(";") ? /[;:]/ : ":").some((dir) => {
    if (!dir) return false;
    try {
      accessSync(join(dir, "pi"), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  })
    ? "pi"
    : null;
}

export function parseEnviron(data: Buffer | string): Record<string, string> {
  const text = typeof data === "string" ? data : data.toString("utf8");
  const out: Record<string, string> = {};
  for (const entry of text.split("\0")) {
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

/** Fill display variables from a logged-in session when this process has none. */
export function pickGraphicalEnv(
  current: NodeJS.ProcessEnv,
  sources: readonly Record<string, string | undefined>[],
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...current };
  if (merged.DISPLAY || merged.WAYLAND_DISPLAY) return merged;
  for (const source of sources) {
    if (!source.DISPLAY && !source.WAYLAND_DISPLAY) continue;
    for (const key of GRAPHICAL_KEYS) {
      if (!merged[key] && source[key]) merged[key] = source[key];
    }
    return merged;
  }
  return merged;
}

export function withToolPath(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const sep = (env.PATH ?? "").includes(";") ? ";" : ":";
  const prefix = [join(home, ".pi", "agent", "bin"), join(home, ".local", "bin")];
  const parts = [...prefix, ...(env.PATH ?? "").split(sep)].filter((part) => part.length > 0);
  const seen = new Set<string>();
  const path = parts.filter((part) => (seen.has(part) ? false : (seen.add(part), true))).join(sep);
  return { ...env, PATH: path };
}

function planFromProcess(sessionFile: string, cwd: string): LaunchPlan {
  const home = homedir();
  const base: NodeJS.ProcessEnv = { ...process.env, HOME: process.env.HOME || home };
  const sources = process.platform === "linux" ? scanSessionEnvirons() : [];
  const env = withToolPath(pickGraphicalEnv(base, sources), home);
  const piPath = findPiBinary(home, env);
  return selectLaunch({
    sessionFile,
    cwd,
    platform: process.platform,
    env,
    have: haveCommand,
    piPath,
    tmuxSession: piPath ? attachedTmuxSession() : null,
    zellijSession: piPath ? attachedZellijSession() : null,
    wezterm: Boolean(piPath) && weztermRunning(),
    launchDisabled: process.env.PI_TELEPORT_NO_LAUNCH === "1",
  });
}

function findTerminal(input: LaunchContext): { command: string; args: string[] } | null {
  const pi = input.piPath;
  if (!pi) return null;
  const piArgs = ["--session", input.sessionFile];
  if (input.platform === "darwin" && input.have("osascript")) {
    const script = `tell application "Terminal" to do script "cd ${quote(input.cwd, input.platform)} && ${quote(pi, input.platform)} --session ${quote(input.sessionFile, input.platform)}"`;
    return { command: "osascript", args: ["-e", script] };
  }
  if (input.platform === "win32") {
    if (input.have("wt.exe") || input.have("wt")) return { command: "wt.exe", args: ["-d", input.cwd, pi, ...piArgs] };
    return { command: "cmd.exe", args: ["/c", "start", "", pi, ...piArgs] };
  }
  if (!input.env.DISPLAY && !input.env.WAYLAND_DISPLAY) return null;
  const terminals: { command: string; args: string[] }[] = [
    { command: "x-terminal-emulator", args: ["-e", pi, ...piArgs] },
    { command: "gnome-terminal", args: [`--working-directory=${input.cwd}`, "--", pi, ...piArgs] },
    { command: "konsole", args: ["--workdir", input.cwd, "-e", pi, ...piArgs] },
    { command: "xfce4-terminal", args: ["--working-directory", input.cwd, "-e", `${quote(pi, input.platform)} --session ${quote(input.sessionFile, input.platform)}`] },
    { command: "alacritty", args: ["--working-directory", input.cwd, "-e", pi, ...piArgs] },
    { command: "kitty", args: ["--directory", input.cwd, pi, ...piArgs] },
    { command: "foot", args: ["--working-directory", input.cwd, pi, ...piArgs] },
    { command: "xterm", args: ["-e", pi, ...piArgs] },
  ];
  return terminals.find((terminal) => input.have(terminal.command)) ?? null;
}

function runAndWait(run: LaunchRun): boolean {
  const result = spawnSync(run.file, run.args, { cwd: run.cwd, env: run.env, stdio: "ignore", timeout: 15000 });
  return result.status === 0;
}

function runDetached(run: LaunchRun): boolean {
  if (process.env.INVOCATION_ID && haveCommand("systemd-run")) {
    const unit = `pi-teleport-resume-${randomBytes(4).toString("hex")}`;
    const result = spawnSync("systemd-run", [
      "--user",
      "--scope",
      "--collect",
      "--quiet",
      "--no-block",
      `--unit=${unit}`,
      "-p",
      systemdValue("WorkingDirectory", run.cwd),
      ...environmentProperties(run.env),
      "--",
      run.file,
      ...run.args,
    ], { env: run.env, stdio: "ignore" });
    if (result.status === 0) return true;
  }
  const child = spawn(run.file, run.args, {
    cwd: run.cwd,
    env: run.env,
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => undefined);
  child.unref();
  return true;
}

function environmentProperties(env: NodeJS.ProcessEnv): string[] {
  const keys = ["HOME", "PATH", "USER", "LOGNAME", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_CURRENT_DESKTOP", "LANG", "SHELL"];
  const args: string[] = [];
  for (const key of keys) {
    const value = env[key];
    if (!value) continue;
    args.push("-p", systemdValue(`Environment=${key}`, value));
  }
  return args;
}

function systemdValue(name: string, value: string): string {
  if (!/[\s"]/.test(value)) return `${name}=${value}`;
  return `${name}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function quote(value: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return `"${value.replaceAll('"', '""')}"`;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function haveCommand(command: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function attachedTmuxSession(): string | null {
  try {
    const output = execFileSync("tmux", ["list-clients", "-F", "#{session_name}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    return output.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? null;
  } catch {
    return null;
  }
}

function attachedZellijSession(): string | null {
  try {
    const output = execFileSync("zellij", ["list-sessions"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    for (const line of output.split("\n")) {
      const match = /^(\S+).*\((\d+)\s+clients?\)/.exec(line.trim());
      if (match && Number(match[2]) > 0) return match[1] ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

function weztermRunning(): boolean {
  try {
    execFileSync("wezterm", ["cli", "list"], { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/** Display variables from another process of this user. The service itself often has none. */
function scanSessionEnvirons(root = "/proc"): Record<string, string>[] {
  const uid = process.getuid?.();
  if (uid === undefined) return [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const status = readFileSync(join(root, name, "status"), "utf8");
      const match = /^Uid:\s+(\d+)/m.exec(status);
      if (!match || Number(match[1]) !== uid) continue;
      const env = parseEnviron(readFileSync(join(root, name, "environ")));
      if (env.DISPLAY || env.WAYLAND_DISPLAY) return [env];
    } catch {
      // This process is not readable.
    }
  }
  return [];
}

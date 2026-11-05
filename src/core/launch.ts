import { execFileSync, spawn } from "node:child_process";

export interface LaunchResult {
  started: boolean;
  command: string;
  note: string;
}

/** A new pi process. This never attaches to a pi that is already running. */
export function launchPi(sessionFile: string, cwd: string): LaunchResult {
  const command = `pi --session ${quote(sessionFile)}`;
  if (process.env.PI_TELEPORT_NO_LAUNCH === "1") {
    return { started: false, command, note: "launch disabled" };
  }
  const terminal = findTerminal(sessionFile, cwd);
  if (!terminal) {
    return {
      started: false,
      command,
      note: "no terminal found; run pi-teleport attach in a terminal on that computer",
    };
  }
  const child = spawn(terminal.command, terminal.args, {
    cwd,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { started: true, command, note: terminal.command };
}

function quote(value: string): string {
  if (process.platform === "win32") return `"${value.replaceAll('"', '""')}"`;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function have(command: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function findTerminal(sessionFile: string, cwd: string): { command: string; args: string[] } | null {
  const piArgs = ["--session", sessionFile];
  if (process.platform === "darwin" && have("osascript")) {
    const script = `tell application "Terminal" to do script "cd ${quote(cwd)} && pi --session ${quote(sessionFile)}"`;
    return { command: "osascript", args: ["-e", script] };
  }
  if (process.platform === "win32") {
    if (have("wt.exe") || have("wt")) return { command: "wt.exe", args: ["-d", cwd, "pi", ...piArgs] };
    return { command: "cmd.exe", args: ["/c", "start", "pi", ...piArgs] };
  }
  const terminals: { command: string; args: string[] }[] = [
    { command: "x-terminal-emulator", args: ["-e", "pi", ...piArgs] },
    { command: "gnome-terminal", args: [`--working-directory=${cwd}`, "--", "pi", ...piArgs] },
    { command: "konsole", args: ["--workdir", cwd, "-e", "pi", ...piArgs] },
    { command: "xfce4-terminal", args: ["--working-directory", cwd, "-e", `pi --session ${quote(sessionFile)}`] },
    { command: "alacritty", args: ["--working-directory", cwd, "-e", "pi", ...piArgs] },
    { command: "kitty", args: ["--directory", cwd, "pi", ...piArgs] },
    { command: "foot", args: ["--working-directory", cwd, "pi", ...piArgs] },
    { command: "xterm", args: ["-e", "pi", ...piArgs] },
  ];
  return terminals.find((terminal) => have(terminal.command)) ?? null;
}

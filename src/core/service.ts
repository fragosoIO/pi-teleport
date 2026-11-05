import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function listenerInvocation(): { node: string; script: string } {
  return {
    node: process.execPath,
    script: fileURLToPath(new URL("../cli.ts", import.meta.url)),
  };
}

export function userUnitPath(home: string): string {
  return join(home, ".config", "systemd", "user", "pi-teleport.service");
}

/** User service so the listener is up whenever this computer is on. */
export function renderUserUnit(options: { node: string; script: string }): string {
  return `[Unit]
Description=pi-teleport listener
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${systemdArg(options.node)} ${systemdArg(options.script)} listen
Restart=always
RestartSec=2
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
`;
}

export async function installUserService(home: string): Promise<{ unit: string; linger: boolean }> {
  const unit = userUnitPath(home);
  await mkdir(dirname(unit), { recursive: true });
  await writeFile(unit, renderUserUnit(listenerInvocation()));
  await exec("systemctl", ["--user", "daemon-reload"]);
  await exec("systemctl", ["--user", "enable", "pi-teleport.service"]);
  // enable --now leaves an already-running process in place. Restart so the
  // service loads the current program and the setup answers just saved.
  await exec("systemctl", ["--user", "restart", "pi-teleport.service"]);
  let linger = true;
  try {
    await exec("loginctl", ["enable-linger", userInfo().username]);
  } catch {
    linger = false;
  }
  return { unit, linger };
}

export async function uninstallUserService(home: string): Promise<void> {
  await exec("systemctl", ["--user", "disable", "--now", "pi-teleport.service"]).catch(() => undefined);
  await rm(userUnitPath(home), { force: true });
  await exec("systemctl", ["--user", "daemon-reload"]);
}

export async function userServiceStatus(): Promise<string> {
  return exec("systemctl", ["--user", "status", "pi-teleport.service", "--no-pager"]);
}

function systemdArg(value: string): string {
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function exec(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || stdout || error.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

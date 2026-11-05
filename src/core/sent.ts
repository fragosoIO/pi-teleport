/**
 * Sessions this computer sent to another computer and has not resumed here.
 * The session file is still frozen, and this computer has not opened it from
 * `/teleport resume`. Unfreeze also removes it, because that continues the copy here.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { FREEZE_TYPE } from "./constants.ts";
import type { JsonRecord } from "./session.ts";

export interface OutboundSession {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  peer: string;
  dest: string;
  sentAt: string;
  title: string;
}

interface FreezeData {
  frozen?: boolean;
  at?: string;
  peer?: string;
  dest?: string;
}

/** Default pi layout stores one directory per project under the sessions root. */
export function sessionsSearchRoot(sessionDir: string): string {
  const base = basename(sessionDir);
  if (base.startsWith("--") && base.endsWith("--")) return dirname(sessionDir);
  return sessionDir;
}

export function sessionSearchRoots(sessionDir: string, home = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = new Set<string>();
  if (sessionDir.trim()) roots.add(sessionsSearchRoot(sessionDir));
  const override = env.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (override) roots.add(override);
  const agent = env.PI_CODING_AGENT_DIR?.trim() || join(home, ".pi", "agent");
  roots.add(join(agent, "sessions"));
  return [...roots];
}

export function outboundFromJsonl(jsonl: string, sessionFile: string): OutboundSession | null {
  let sessionId = "";
  let cwd = "";
  let name = "";
  let user = "";
  let freeze: FreezeData | undefined;
  let sentAt = "";
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: JsonRecord;
    try {
      record = JSON.parse(trimmed) as JsonRecord;
    } catch {
      continue;
    }
    if (record.type === "session") {
      if (typeof record.id === "string") sessionId = record.id;
      if (typeof record.cwd === "string") cwd = record.cwd;
      continue;
    }
    if (record.type === "session_info" && typeof record.name === "string" && record.name.trim()) {
      name = record.name.trim();
      continue;
    }
    if (!user && record.type === "message") user = userText(record.message);
    if (record.type === "custom" && record.customType === FREEZE_TYPE) {
      const data = record.data as FreezeData | undefined;
      freeze = data ?? {};
      sentAt = typeof data?.at === "string" ? data.at : typeof record.timestamp === "string" ? record.timestamp : "";
    }
  }
  const peer = freeze?.peer?.trim() ?? "";
  if (!sessionId || !freeze?.frozen || !peer) return null;
  const title = oneLine(name || user || basename(cwd) || sessionId);
  return {
    sessionId,
    sessionFile,
    cwd,
    peer,
    dest: freeze.dest?.trim() ?? "",
    sentAt,
    title,
  };
}

export function pendingOutbound(sessions: readonly OutboundSession[], resumedIds: ReadonlySet<string>): OutboundSession[] {
  return sessions.filter((session) => !resumedIds.has(session.sessionId));
}

export function resumedFile(root: string): string {
  return join(root, "resumed.json");
}

export async function loadResumedIds(file: string): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { ids?: unknown };
    const ids = Array.isArray(parsed.ids) ? parsed.ids.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
    return new Set(ids);
  } catch {
    return new Set();
  }
}

export async function rememberResumed(file: string, sessionId: string): Promise<void> {
  const ids = await loadResumedIds(file);
  if (ids.has(sessionId)) return;
  ids.add(sessionId);
  await mkdir(dirname(file), { recursive: true });
  const body = `${JSON.stringify({ ids: [...ids].sort() }, null, 2)}\n`;
  await writeFile(file, body, { mode: 0o600 });
}

export function outboundLabel(session: OutboundSession): string {
  const when = session.sentAt ? session.sentAt.replace("T", " ").slice(0, 16) : "unknown time";
  return `${session.title} → ${session.peer} · ${when}`;
}

/** Labels are unique so a picker can map a choice back to one session. */
export function outboundChoices(sessions: readonly OutboundSession[]): { label: string; session: OutboundSession }[] {
  const counts = new Map<string, number>();
  const base = sessions.map((session) => {
    const label = outboundLabel(session);
    counts.set(label, (counts.get(label) ?? 0) + 1);
    return { label, session };
  });
  return base.map((item) => {
    if ((counts.get(item.label) ?? 0) < 2) return item;
    return { label: `${item.label} · ${item.session.sessionId.slice(0, 8)}`, session: item.session };
  });
}

export async function loadOutboundSessions(root: string): Promise<OutboundSession[]> {
  let names: string[];
  try {
    names = await readdir(root, { recursive: true });
  } catch {
    return [];
  }
  const found: OutboundSession[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const sessionFile = join(root, name);
    try {
      const session = outboundFromJsonl(await readFile(sessionFile, "utf8"), sessionFile);
      if (session) found.push(session);
    } catch {
      // A session file can disappear or be unreadable while the list is built.
    }
  }
  found.sort((a, b) => b.sentAt.localeCompare(a.sentAt) || a.sessionFile.localeCompare(b.sessionFile));
  return found;
}

export async function collectOutboundSessions(roots: readonly string[]): Promise<OutboundSession[]> {
  const byFile = new Map<string, OutboundSession>();
  for (const root of roots) {
    for (const session of await loadOutboundSessions(root)) byFile.set(session.sessionFile, session);
  }
  return [...byFile.values()].sort((a, b) => b.sentAt.localeCompare(a.sentAt) || a.sessionFile.localeCompare(b.sessionFile));
}

function userText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const record = message as { role?: string; content?: unknown };
  if (record.role !== "user") return "";
  if (typeof record.content === "string") return record.content;
  if (!Array.isArray(record.content)) return "";
  return record.content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
      return (part as { text: string }).text;
    }
    return "";
  }).join(" ");
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= 48) return line;
  return `${line.slice(0, 47)}…`;
}

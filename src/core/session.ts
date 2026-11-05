/**
 * Pi sessions are JSONL. Version 3, header then tree entries with id/parentId.
 * The restored file is a new session id in the destination cwd. Model selections
 * are dropped so the target keeps whatever model pi is already configured to use.
 * Entry ids stay so the conversation tree still links.
 */

import { randomUUID } from "node:crypto";

import { ORIGIN_TYPE } from "./constants.ts";
import { rewriteText, type ExactReplacement, type PathRoots } from "./paths.ts";

export interface JsonRecord {
  [key: string]: unknown;
}

export interface RewriteSessionResult {
  jsonl: string;
  sessionId: string;
  cwd: string;
}

export function rewriteSession(
  jsonl: string,
  from: PathRoots,
  to: PathRoots,
  destCwd: string,
  exact: readonly ExactReplacement[],
  origin: { sourceSessionId?: string; sourceCwd: string },
  now = new Date(),
): RewriteSessionResult {
  const records = parseJsonl(jsonl);
  const header = records.find((record) => record.type === "session");
  const links = new Map<string, string | null>();
  const dropped = new Set<string>();
  for (const record of records) {
    if (record.type === "session" || typeof record.id !== "string") continue;
    links.set(record.id, typeof record.parentId === "string" ? record.parentId : null);
    if (record.type === "model_change") dropped.add(record.id);
  }
  const entries = records.filter((record) => record.type !== "session" && record.type !== "model_change");
  rewireAfterDrops(entries, links, dropped);

  const sessionId = randomUUID();
  const timestamp = now.toISOString();
  const rewrittenHeader: JsonRecord = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp,
    cwd: destCwd,
  };
  const rewrittenEntries = entries.map((entry) => rewriteValue(entry, from, to, exact) as JsonRecord);
  const originEntry: JsonRecord = {
    type: "custom",
    customType: ORIGIN_TYPE,
    id: randomUUID().slice(0, 8),
    parentId: findLeaf(rewrittenEntries),
    timestamp,
    data: {
      sourceSessionId: origin.sourceSessionId ?? (typeof header?.id === "string" ? header.id : undefined),
      sourceCwd: origin.sourceCwd,
    },
  };
  const lines = [rewrittenHeader, ...rewrittenEntries, originEntry].map((record) => JSON.stringify(record));
  return { jsonl: `${lines.join("\n")}\n`, sessionId, cwd: destCwd };
}

export function parseJsonl(jsonl: string): JsonRecord[] {
  return jsonl
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonRecord);
}

/** Point children of removed entries at the nearest remaining parent. */
export function rewireAfterDrops(
  entries: JsonRecord[],
  links: ReadonlyMap<string, string | null>,
  dropped: ReadonlySet<string>,
): void {
  const resolve = (id: unknown): string | null => {
    let current = typeof id === "string" ? id : null;
    const seen = new Set<string>();
    while (current && dropped.has(current)) {
      if (seen.has(current)) return null;
      seen.add(current);
      const next = links.get(current);
      current = next === undefined ? null : next;
    }
    return current;
  };
  for (const entry of entries) {
    if ("parentId" in entry) entry.parentId = resolve(entry.parentId);
  }
}

function findLeaf(entries: readonly JsonRecord[]): string | null {
  const parents = new Set(entries.map((entry) => entry.parentId).filter((id): id is string => typeof id === "string"));
  const leaves = entries.filter((entry) => typeof entry.id === "string" && !parents.has(entry.id));
  const leaf = leaves.at(-1);
  return typeof leaf?.id === "string" ? leaf.id : null;
}

function rewriteValue(value: unknown, from: PathRoots, to: PathRoots, exact: readonly ExactReplacement[]): unknown {
  if (typeof value === "string") return rewriteText(value, from, to, exact);
  if (Array.isArray(value)) return value.map((item) => rewriteValue(item, from, to, exact));
  if (value && typeof value === "object") {
    const out: JsonRecord = {};
    for (const [key, inner] of Object.entries(value)) out[key] = rewriteValue(inner, from, to, exact);
    return out;
  }
  return value;
}

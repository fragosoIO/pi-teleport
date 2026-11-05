/**
 * Paths the session actually read or wrote, taken from pi tool calls.
 * Directory listings are candidates; the snapshot keeps real files only.
 */

import { recordToolsUsed, type ToolUse } from "./manifest.ts";
import type { JsonRecord } from "./session.ts";

const FILE_ARGUMENT = /^(?:path|file|filePath|file_path|fullOutputPath)$/;

export function collectTouchedPaths(entries: readonly JsonRecord[]): string[] {
  const found: string[] = [];
  for (const entry of entries) {
    walk(entry, found);
  }
  return [...new Set(found)];
}

export function collectCommands(entries: readonly JsonRecord[]): string[] {
  const commands: string[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as JsonRecord;
    if (typeof record.command === "string") commands.push(record.command);
    for (const inner of Object.values(record)) visit(inner);
  };
  for (const entry of entries) visit(entry);
  return commands;
}

export function toolsFromSession(entries: readonly JsonRecord[]): ToolUse[] {
  return recordToolsUsed(collectCommands(entries));
}

function walk(value: unknown, found: string[]): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, found);
    return;
  }
  const record = value as JsonRecord;
  if (record.type === "toolCall" && record.arguments && typeof record.arguments === "object") {
    takeArguments(record.arguments as JsonRecord, found);
  }
  if (typeof record.name === "string" && record.arguments && typeof record.arguments === "object") {
    takeArguments(record.arguments as JsonRecord, found);
  }
  if (typeof record.command === "string") {
    for (const path of pathsInCommand(record.command)) found.push(path);
  }
  for (const [key, inner] of Object.entries(record)) {
    if (FILE_ARGUMENT.test(key) && typeof inner === "string") found.push(inner);
    else walk(inner, found);
  }
}

function takeArguments(args: JsonRecord, found: string[]): void {
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && (FILE_ARGUMENT.test(key) || key === "path")) found.push(value);
    if (key === "command" && typeof value === "string") {
      for (const path of pathsInCommand(value)) found.push(path);
    }
  }
}

/** Absolute paths and home paths that appear in a shell command. */
export function pathsInCommand(command: string): string[] {
  const found: string[] = [];
  const pattern = /(?:^|[\s"'=<>])((?:\/|~\/)[^\s"'`;|&<>]+|(?:[A-Za-z]:\\)[^\s"'`;|&<>]+)/g;
  for (const match of command.matchAll(pattern)) {
    found.push(match[1]);
  }
  return found;
}

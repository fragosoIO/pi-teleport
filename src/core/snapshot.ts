import { createHash } from "node:crypto";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { collectCommands, collectTouchedPaths, pathsInCommand } from "./collect.ts";
import { createManifest, recordToolsUsed, type SessionManifest } from "./manifest.ts";
import { isAbsolutePath, relativeInside, type OsName, type PathRoots } from "./paths.ts";
import type { JsonRecord } from "./session.ts";

export interface FileMeta {
  index: number;
  kind: "project" | "external" | "session";
  size: number;
  mode: number;
  relative?: string;
  sourcePath?: string;
  symlink?: string;
  directory?: boolean;
  sha256: string;
}

export interface LocalFile extends FileMeta {
  diskPath?: string;
  bytes?: Buffer;
}

export interface Snapshot {
  files: LocalFile[];
  manifest: SessionManifest;
  /** Files that could not be read. Shown to the user; the rest still sends. */
  failures: string[];
}

export interface SnapshotProgress {
  phase: "listing" | "reading";
  /** Files listed so far, or bytes read, depending on `phase`. */
  done: number;
  /** Total bytes to read. Set only while reading. */
  total?: number;
  file?: string;
  fileIndex: number;
  /** Files found, including the session. Set only while reading. */
  fileCount?: number;
}

export function fileLabel(file: Pick<LocalFile, "kind" | "relative" | "sourcePath">): string | undefined {
  if (file.kind === "session") return "session";
  return file.relative ?? file.sourcePath;
}

export async function buildSnapshot(options: {
  project: string;
  home: string;
  os: OsName;
  name: string;
  peerName: string;
  target: PathRoots;
  destPath: string;
  sessionJsonl: string;
  entries: readonly JsonRecord[];
  /** Absolute path of the live session file, when pi has already flushed one. */
  sessionFile?: string;
  onProgress?: (event: SnapshotProgress) => void;
}): Promise<Snapshot> {
  const from: PathRoots = { os: options.os, home: options.home, project: options.project };
  const failures: string[] = [];
  const files: LocalFile[] = [];
  const listed = (file: LocalFile) => {
    options.onProgress?.({
      phase: "listing",
      done: files.length,
      file: fileLabel(file),
      fileIndex: files.length - 1,
    });
  };
  await walk(options.project, options.project, files, failures, listed);

  const touched = await listExternalFiles(options.entries, options.project, options.home, options.os, options.sessionFile);
  for (const sourcePath of touched) {
    try {
      const stat = await lstat(sourcePath);
      if (!stat.isFile()) continue;
      const file: LocalFile = {
        index: 0,
        kind: "external",
        size: stat.size,
        mode: stat.mode & 0o777,
        sourcePath,
        sha256: "",
        diskPath: sourcePath,
      };
      files.push(file);
      listed(file);
    } catch (error) {
      failures.push(`${sourcePath}: ${(error as Error).message}`);
    }
  }

  const sessionBytes = Buffer.from(options.sessionJsonl);
  files.push({
    index: 0,
    kind: "session",
    size: sessionBytes.length,
    mode: 0o600,
    sha256: "",
    bytes: sessionBytes,
  });
  const kept = await hashListed(files, failures, options.onProgress);
  reindex(kept);

  const commands = collectCommands(options.entries);
  const manifest = createManifest({
    source: { ...from, name: options.name },
    target: { ...options.target, name: options.peerName },
    destPath: options.destPath,
    toolsUsed: recordToolsUsed(commands),
    externalFileCount: kept.filter((file) => file.kind === "external").length,
    createdAt: new Date().toISOString(),
  });
  return { files: kept, manifest, failures };
}

function reindex(files: LocalFile[]): void {
  files.forEach((file, index) => {
    file.index = index;
  });
}

async function hashListed(
  files: readonly LocalFile[],
  failures: string[],
  onProgress?: (event: SnapshotProgress) => void,
): Promise<LocalFile[]> {
  const kept: LocalFile[] = [];
  let total = files.reduce((sum, file) => sum + file.size, 0);
  let done = 0;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const base = done;
    const report = () => {
      onProgress?.({
        phase: "reading",
        done,
        total,
        file: fileLabel(file),
        fileIndex: index,
        fileCount: files.length,
      });
    };
    report();
    try {
      let accounted = 0;
      await hashOne(file, (n) => {
        accounted += n;
        done = base + Math.min(file.size, accounted);
        report();
      });
      done = base + file.size;
      report();
      kept.push(file);
    } catch (error) {
      done = base;
      total -= file.size;
      const path = file.diskPath ?? file.sourcePath ?? file.relative ?? "session";
      failures.push(`${path}: ${(error as Error).message}`);
    }
  }
  return kept;
}

async function hashOne(file: LocalFile, onBytes: (n: number) => void): Promise<void> {
  if (file.directory || file.symlink !== undefined) return;
  if (file.bytes) {
    file.sha256 = createHash("sha256").update(file.bytes).digest("hex");
    if (file.bytes.length > 0) onBytes(file.bytes.length);
    return;
  }
  if (!file.diskPath) return;
  file.sha256 = await hashFile(file.diskPath, onBytes);
}

async function walk(
  root: string,
  dir: string,
  files: LocalFile[],
  failures: string[],
  onFile?: (file: LocalFile) => void,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    failures.push(`${dir}: ${(error as Error).message}`);
    return;
  }
  names.sort();
  if (names.length === 0 && dir !== root) {
    const file: LocalFile = {
      index: 0,
      kind: "project",
      size: 0,
      mode: 0o755,
      relative: relativePosix(root, dir),
      directory: true,
      sha256: "",
    };
    files.push(file);
    onFile?.(file);
  }
  for (const name of names) {
    const absolute = join(dir, name);
    let stat;
    try {
      stat = await lstat(absolute);
    } catch (error) {
      failures.push(`${absolute}: ${(error as Error).message}`);
      continue;
    }
    const relative = relativePosix(root, absolute);
    if (stat.isSymbolicLink()) {
      try {
        const target = await readlink(absolute);
        const file: LocalFile = {
          index: 0,
          kind: "project",
          size: 0,
          mode: stat.mode & 0o777,
          relative,
          symlink: target,
          sha256: "",
          diskPath: absolute,
        };
        files.push(file);
        onFile?.(file);
      } catch (error) {
        failures.push(`${absolute}: ${(error as Error).message}`);
      }
      continue;
    }
    if (stat.isDirectory()) {
      await walk(root, absolute, files, failures, onFile);
      continue;
    }
    if (!stat.isFile()) {
      failures.push(`${absolute}: not a regular file, skipped`);
      continue;
    }
    const file: LocalFile = {
      index: 0,
      kind: "project",
      size: stat.size,
      mode: stat.mode & 0o777,
      relative,
      sha256: "",
      diskPath: absolute,
    };
    files.push(file);
    onFile?.(file);
  }
}

function relativePosix(root: string, full: string): string {
  const rel = full.slice(root.length).replaceAll("\\", "/");
  return rel.replace(/^\/+/, "");
}

/** Existing files outside the project that this session read or wrote. */
export async function listExternalFiles(
  entries: readonly JsonRecord[],
  project: string,
  home: string,
  os: OsName,
  sessionFile?: string,
): Promise<string[]> {
  const touched = new Set<string>();
  for (const candidate of collectTouchedPaths(entries)) {
    const absolute = resolveTouched(candidate, project, home, os);
    if (!absolute) continue;
    if (sessionFile && absolute === sessionFile) continue;
    if (relativeInside(project, absolute, os) !== null) continue;
    try {
      const stat = await lstat(absolute);
      if (stat.isFile()) touched.add(absolute);
    } catch {
      // The session mentioned a path that is not a file anymore.
    }
  }
  return [...touched];
}

export function resolveTouched(candidate: string, project: string, home: string, os: OsName): string | null {
  if (!candidate || candidate.includes("\0")) return null;
  if (candidate.startsWith("~/") || candidate === "~") {
    const rest = candidate === "~" ? "" : candidate.slice(2);
    return join(home, rest);
  }
  if (isAbsolutePath(candidate, os) || candidate.startsWith("/") || /^[A-Za-z]:[\\/]/.test(candidate)) {
    return candidate;
  }
  return resolve(project, candidate);
}

export async function hashFile(path: string, onBytes?: (n: number) => void): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, "r");
  try {
    const stream = handle.createReadStream();
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      hash.update(buf);
      onBytes?.(buf.length);
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

export function metaOf(file: LocalFile): FileMeta {
  return {
    index: file.index,
    kind: file.kind,
    size: file.size,
    mode: file.mode,
    relative: file.relative,
    sourcePath: file.sourcePath,
    symlink: file.symlink,
    directory: file.directory,
    sha256: file.sha256,
  };
}

/** Re-export so snapshot callers can parse shell paths without a second import. */
export { pathsInCommand };

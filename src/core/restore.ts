import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { planExternalPlacement, type ExternalPlacement } from "./external.ts";
import type { SessionManifest } from "./manifest.ts";
import type { ResumeModel } from "./models.ts";
import { assertSafeDestination, joinOs, piSessionDirName, type PathRoots } from "./paths.ts";
import { rewriteSession } from "./session.ts";
import type { FileMeta } from "./snapshot.ts";

export interface StoredFile extends FileMeta {
  received: number;
}

export interface TransferState {
  transferId: string;
  destPath: string;
  overwriteDest: boolean;
  manifest: SessionManifest;
  skipSourcePaths: string[];
  files: StoredFile[];
}

export interface ApplyResult {
  sessionFile: string;
  symlinkFailures: string[];
  primaryFallback: number;
  unreadable: string[];
}

export function formatSymlinkFailure(path: string, target: string, error: string): string {
  return `symlink failed: ${path} -> ${target}: ${error}`;
}

export async function applyTransfer(options: {
  state: TransferState;
  stageDir: string;
  sessionsRoot: string;
  /** Model this computer uses when the received session resumes. */
  resumeModel?: ResumeModel;
  /** When set, a file write uses this instead of the real filesystem. Tests use the default. */
  now?: Date;
}): Promise<ApplyResult> {
  const manifest = options.state.manifest;
  const from: PathRoots = manifest.source;
  const to: PathRoots = manifest.target;
  const dest = options.state.destPath;
  assertSafeDestination(dest, to.home, to.os);
  if (await exists(dest)) {
    if (!options.state.overwriteDest) throw new Error(`destination already exists: ${dest}`);
    await rm(dest, { recursive: true, force: true });
  }
  await mkdir(dest, { recursive: true });

  const symlinkFailures: string[] = [];
  const placements: ExternalPlacement[] = [];
  const skip = new Set(options.state.skipSourcePaths);

  for (const file of options.state.files) {
    if (file.kind === "session") continue;
    if (file.kind === "project") {
      const target = joinOs(to.os, dest, file.relative ?? "");
      if (file.directory) {
        await mkdir(target, { recursive: true });
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      if (file.symlink !== undefined) {
        const linkTarget = file.symlink;
        try {
          await symlink(linkTarget, target);
        } catch (error) {
          symlinkFailures.push(formatSymlinkFailure(target, linkTarget, (error as Error).message));
        }
        continue;
      }
      await writeStaged(options.stageDir, file, target);
      continue;
    }
    if (!file.sourcePath) continue;
    const allowed = !skip.has(file.sourcePath);
    let placement = planExternalPlacement(file.sourcePath, from, to, allowed);
    if (!placement) continue;
    if (placement.writePrimary) {
      const primary = placement.primaryPath;
      try {
        await mkdir(dirname(primary), { recursive: true });
        const current = await lstat(primary).catch(() => null);
        if (current?.isDirectory()) throw new Error("target is a directory");
        await writeStaged(options.stageDir, file, primary);
      } catch {
        await rm(primary, { force: true }).catch(() => undefined);
        placement = planExternalPlacement(file.sourcePath, from, to, false) ?? placement;
      }
    }
    await mkdir(dirname(placement.sparePath), { recursive: true });
    await writeStaged(options.stageDir, file, placement.sparePath);
    placements.push(placement);
  }

  const session = options.state.files.find((file) => file.kind === "session");
  if (!session) throw new Error("transfer has no session");
  const original = await readFile(join(options.stageDir, String(session.index)));
  if (session.sha256 && sha(original) !== session.sha256) throw new Error("session checksum mismatch");
  const rewritten = rewriteSession(
    original.toString("utf8"),
    from,
    to,
    dest,
    placements.map((item) => ({ from: item.sourcePath, to: item.sessionPath })),
    { sourceCwd: from.project },
    options.resumeModel,
    options.now,
  );
  const sessionDir = join(options.sessionsRoot, piSessionDirName(dest));
  await mkdir(sessionDir, { recursive: true });
  const stamp = rewritten.jsonl ? (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-") : "";
  const sessionFile = join(sessionDir, `${stamp}_${rewritten.sessionId}.jsonl`);
  await writeFile(sessionFile, rewritten.jsonl, { mode: 0o600 });

  const primaryFallback = placements.filter((item) => !item.writePrimary).length;
  const storedManifest: SessionManifest = {
    ...manifest,
    destPath: dest,
    externalFileCount: placements.length,
  };
  const manifestPath = joinOs(to.os, dest, ".pi-teleport/manifest.json");
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(storedManifest, null, 2)}\n`);

  return { sessionFile, symlinkFailures, primaryFallback, unreadable: [] };
}

async function writeStaged(stageDir: string, file: StoredFile, target: string): Promise<void> {
  const data = await readFile(join(stageDir, String(file.index)));
  if (file.sha256 && sha(data) !== file.sha256) {
    throw new Error(`checksum mismatch for ${file.relative ?? file.sourcePath ?? file.index}`);
  }
  await writeFile(target, data, { mode: file.mode || 0o644 });
  await chmod(target, file.mode || 0o644).catch(() => undefined);
}

function sha(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

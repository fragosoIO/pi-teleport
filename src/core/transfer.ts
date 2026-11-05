import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CHUNK_SIZE } from "./constants.ts";
import type { PeerLink } from "./link.ts";
import { assertSafeDestination, type OsName } from "./paths.ts";
import { noteChunk, resumeCursor, type FileCursor } from "./resume.ts";
import { applyTransfer, type StoredFile, type TransferState } from "./restore.ts";
import { metaOf, type LocalFile } from "./snapshot.ts";

export interface SendPlan {
  transferId: string;
  destPath: string;
  overwriteDest: boolean;
  manifest: TransferState["manifest"];
  skipSourcePaths: string[];
  files: LocalFile[];
}

export interface SendOptions {
  resume?: boolean;
  chunkSize?: number;
  /** Test hook: close the socket after this many acked chunks. */
  dropAfterChunks?: number;
}

export interface SendResult {
  sessionFile: string;
  symlinkFailures: string[];
  primaryFallback: number;
  launchCommand?: string;
  launched?: boolean;
  bytesSent: number;
}

export interface ProbeResult {
  destExists: boolean;
  collisions: string[];
  error?: string;
}

export async function probeDestination(link: PeerLink, destPath: string, primaryPaths: readonly string[]): Promise<ProbeResult> {
  link.sendJson({ t: "probe", destPath, primaryPaths: [...primaryPaths] });
  const reply = await link.nextJson();
  if (reply.t !== "probe-result") throw new Error(`expected probe-result, got ${reply.t}`);
  return {
    destExists: Boolean(reply.destExists),
    collisions: Array.isArray(reply.collisions) ? reply.collisions.map(String) : [],
    error: reply.error ? String(reply.error) : undefined,
  };
}

export async function sendPlan(link: PeerLink, plan: SendPlan, options: SendOptions = {}): Promise<SendResult> {
  const chunkSize = options.chunkSize ?? CHUNK_SIZE;
  if (options.resume) {
    link.sendJson({ t: "resume", transferId: plan.transferId });
  } else {
    link.sendJson({
      t: "begin",
      transferId: plan.transferId,
      destPath: plan.destPath,
      overwriteDest: plan.overwriteDest,
      manifest: plan.manifest,
      skipSourcePaths: plan.skipSourcePaths,
      fileCount: plan.files.length,
    });
    const metas = plan.files.map(metaOf);
    const batch = 500;
    if (metas.length === 0) {
      link.sendJson({ t: "files", files: [], last: true });
    }
    for (let index = 0; index < metas.length; index += batch) {
      link.sendJson({ t: "files", files: metas.slice(index, index + batch), last: index + batch >= metas.length });
    }
  }

  const ready = await link.nextJson();
  if (ready.t === "restart") {
    if (!options.resume) throw new Error("receiver lost the transfer");
    return sendPlan(link, plan, { ...options, resume: false, dropAfterChunks: undefined });
  }
  if (ready.t !== "ready") throw new Error(`expected ready, got ${ready.t}`);

  let fileIndex = Number(ready.fileIndex ?? 0);
  let offset = Number(ready.offset ?? 0);
  let bytesSent = 0;
  let chunks = 0;
  while (fileIndex < plan.files.length) {
    const file = plan.files[fileIndex];
    if (file.size === 0 || offset >= file.size) {
      fileIndex += 1;
      offset = 0;
      continue;
    }
    const length = Math.min(chunkSize, file.size - offset);
    const data = await readRange(file, offset, length);
    link.sendChunk(file.index, offset, data);
    const ack = await link.nextJson();
    if (ack.t !== "ack" || Number(ack.fileIndex) !== file.index) throw new Error("bad acknowledgement");
    bytesSent += data.length;
    chunks += 1;
    if (options.dropAfterChunks && chunks >= options.dropAfterChunks) {
      link.close();
      const dropped = new Error("dropped");
      (dropped as Error & { bytesSent: number }).bytesSent = bytesSent;
      throw dropped;
    }
    const acked = Number(ack.offset);
    if (acked >= file.size) {
      fileIndex += 1;
      offset = 0;
    } else {
      offset = acked;
    }
  }
  link.sendJson({ t: "commit" });
  const done = await link.nextJson();
  if (done.t === "error") throw new Error(String(done.message ?? "transfer failed"));
  if (done.t !== "done") throw new Error(`expected done, got ${done.t}`);
  link.finish();
  return {
    sessionFile: String(done.sessionFile ?? ""),
    symlinkFailures: Array.isArray(done.symlinkFailures) ? done.symlinkFailures.map(String) : [],
    primaryFallback: Number(done.primaryFallback ?? 0),
    launchCommand: done.launchCommand ? String(done.launchCommand) : undefined,
    launched: Boolean(done.launched),
    bytesSent,
  };
}

export async function readRange(file: LocalFile, offset: number, length: number): Promise<Buffer> {
  if (file.bytes) return Buffer.from(file.bytes.subarray(offset, offset + length));
  if (!file.diskPath) throw new Error(`file ${file.index} has no source`);
  const handle = await open(file.diskPath, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, offset);
    if (bytesRead !== length) throw new Error(`short read of ${file.diskPath}`);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export interface ReceiverOptions {
  stateRoot: string;
  sessionsRoot: string;
  home: string;
  os: OsName;
  exists: (path: string) => Promise<boolean>;
  launch: (sessionFile: string, cwd: string) => Promise<{ started: boolean; command: string }>;
}

/** One accepted connection. A dropped socket leaves the partial state on disk. */
export async function receiveSession(link: PeerLink, options: ReceiverOptions): Promise<void> {
  try {
    let message = await link.nextJson();
    if (message.t === "probe") {
      const destPath = String(message.destPath ?? "");
      const primaryPaths = Array.isArray(message.primaryPaths) ? message.primaryPaths.map(String) : [];
      let error: string | undefined;
      try {
        assertSafeDestination(destPath, options.home, options.os);
      } catch (cause) {
        error = (cause as Error).message;
      }
      const collisions: string[] = [];
      let destExists = false;
      if (!error) {
        destExists = await options.exists(destPath);
        for (const path of primaryPaths) {
          if (await options.exists(path)) collisions.push(path);
        }
      }
      link.sendJson({ t: "probe-result", destExists, collisions, error });
      message = await link.nextJson();
    }
    if (message.t === "resume") {
      const state = await loadState(options.stateRoot, String(message.transferId));
      if (!state) {
        link.sendJson({ t: "restart" });
        return;
      }
      await receiveBody(link, state, options);
      return;
    }
    if (message.t !== "begin") throw new Error(`unexpected message ${message.t}`);
    const files: StoredFile[] = [];
    for (;;) {
      const batch = await link.nextJson();
      if (batch.t !== "files") throw new Error("expected the file list");
      const incoming = Array.isArray(batch.files) ? batch.files : [];
      for (const file of incoming) files.push({ ...(file as StoredFile), received: 0 });
      if (batch.last) break;
    }
    const state: TransferState = {
      transferId: String(message.transferId),
      destPath: String(message.destPath),
      overwriteDest: Boolean(message.overwriteDest),
      manifest: message.manifest as TransferState["manifest"],
      skipSourcePaths: Array.isArray(message.skipSourcePaths) ? message.skipSourcePaths.map(String) : [],
      files,
    };
    await rm(join(options.stateRoot, state.transferId), { recursive: true, force: true });
    await saveState(options.stateRoot, state);
    await seedEmpty(options.stateRoot, state);
    await receiveBody(link, state, options);
  } catch {
    // The partial files stay in the state directory so the next connection can resume.
  }
}

async function receiveBody(link: PeerLink, state: TransferState, options: ReceiverOptions): Promise<void> {
  let cursors: FileCursor[] = state.files.map((file) => ({ size: file.size, received: file.received }));
  const point = resumeCursor(cursors);
  link.sendJson({
    t: "ready",
    transferId: state.transferId,
    fileIndex: point?.fileIndex ?? state.files.length,
    offset: point?.offset ?? 0,
  });
  for (;;) {
    const message = await link.next();
    if (message.kind === "chunk") {
      const file = state.files[message.fileIndex];
      if (!file || file.index !== message.fileIndex) throw new Error("chunk for an unknown file");
      cursors = noteChunk(cursors, message.fileIndex, message.offset, message.data.length);
      file.received = cursors[message.fileIndex].received;
      const stage = join(options.stateRoot, state.transferId, "stage", String(file.index));
      await mkdir(dirname(stage), { recursive: true });
      const handle = await open(stage, "r+").catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return open(stage, "w+");
      });
      try {
        await handle.write(message.data, 0, message.data.length, message.offset);
      } finally {
        await handle.close();
      }
      await saveState(options.stateRoot, state);
      link.sendJson({ t: "ack", fileIndex: message.fileIndex, offset: file.received });
      continue;
    }
    if (message.value.t === "commit") {
      const unfinished = state.files.find((file) => file.received !== file.size);
      if (unfinished) throw new Error(`incomplete file ${unfinished.index}`);
      const applied = await applyTransfer({
        state,
        stageDir: join(options.stateRoot, state.transferId, "stage"),
        sessionsRoot: options.sessionsRoot,
      });
      const launch = await options.launch(applied.sessionFile, state.destPath);
      link.sendJson({
        t: "done",
        sessionFile: applied.sessionFile,
        symlinkFailures: applied.symlinkFailures,
        primaryFallback: applied.primaryFallback,
        launchCommand: launch.command,
        launched: launch.started,
      });
      await rm(join(options.stateRoot, state.transferId), { recursive: true, force: true });
      link.finish();
      return;
    }
    throw new Error(`unexpected message ${message.kind === "json" ? message.value.t : "chunk"}`);
  }
}

async function seedEmpty(root: string, state: TransferState): Promise<void> {
  for (const file of state.files) {
    if (file.size !== 0 || file.directory || file.symlink !== undefined) continue;
    const stage = join(root, state.transferId, "stage", String(file.index));
    await mkdir(dirname(stage), { recursive: true });
    await writeFile(stage, Buffer.alloc(0));
  }
}

async function saveState(root: string, state: TransferState): Promise<void> {
  const dir = join(root, state.transferId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "state.json");
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, path);
}

async function loadState(root: string, transferId: string): Promise<TransferState | null> {
  try {
    const raw = await readFile(join(root, transferId, "state.json"), "utf8");
    return JSON.parse(raw) as TransferState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

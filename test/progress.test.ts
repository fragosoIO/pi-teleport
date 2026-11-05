import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  formatBytes,
  formatProgress,
  listingState,
  readingState,
  retryState,
  sendingState,
} from "../src/core/progress.ts";
import { buildSnapshot } from "../src/core/snapshot.ts";

test("the bar matches the bytes finished in the current phase", () => {
  const listing = formatProgress(listingState(3, "src/a.txt", "laptop"));
  assert.equal(listing.title, "Teleporting to laptop");
  assert.equal(listing.filled, 0);
  assert.equal(listing.percent, undefined);
  assert.match(listing.detail, /Listing project files  3 files/);
  assert.match(listing.detail, /src\/a\.txt/);

  const half = formatProgress(readingState({
    done: 50,
    total: 100,
    file: "src/a.txt",
    fileIndex: 1,
    fileCount: 4,
  }, "laptop"));
  assert.equal(half.percent, "50%");
  assert.equal(half.filled, half.width / 2);
  assert.equal(half.amounts, "50 B / 100 B");
  assert.match(half.detail, /Reading project files  2\/4  src\/a\.txt/);

  const started = formatProgress({ status: "Sending  1/2", done: 1, total: 10_000, file: "src/a.txt" });
  assert.equal(started.filled, 1);
  assert.equal(started.percent, "0%");

  const almost = formatProgress(sendingState({
    phase: "sending",
    done: 99,
    total: 100,
    fileIndex: 0,
    fileCount: 2,
    file: "payload.bin",
  }, "laptop"));
  assert.equal(almost.filled, almost.width - 1);
  assert.equal(almost.percent, "99%");
  assert.match(almost.status, /Sending  1\/2/);
  assert.match(almost.status, /payload\.bin/);

  const full = formatProgress(sendingState({
    phase: "writing",
    done: 100,
    total: 100,
    fileIndex: 1,
    fileCount: 2,
    file: "session",
  }, "laptop"));
  assert.equal(full.filled, full.width);
  assert.equal(full.percent, "100%");
  assert.equal(full.detail, "Writing the session on the other computer");
  assert.equal(full.amounts, "100 B / 100 B");

  const long = `${"dir/".repeat(20)}file.txt`;
  const clipped = formatProgress({ status: "Sending  1/1", done: 1, total: 2, file: long });
  assert.match(clipped.detail, new RegExp(long.replaceAll("/", "\\/")));
  assert.ok(clipped.status.length < clipped.detail.length);
  assert.match(clipped.status, /file\.txt$/);

  const resumed = retryState({
    status: "Sending  1/2",
    done: 40,
    total: 100,
    file: "payload.bin",
    peer: "laptop",
  }, 2);
  assert.equal(resumed.done, 40);
  assert.equal(resumed.file, "payload.bin");
  assert.equal(resumed.status, "Connection dropped, resuming (2)");
});

test("byte labels stay short", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(10 * 1024 * 1024), "10 MB");
});

test("reading a project reports each file and finishes at the byte total", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-teleport-progress-"));
  const project = join(root, "app");
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "src", "a.txt"), "hello");
  await writeFile(join(project, "empty.txt"), "");
  await symlink("a.txt", join(project, "src", "link.txt"));
  const sessionJsonl = `${JSON.stringify({ type: "session", version: 3, id: "abc" })}\n`;
  const events: { phase: string; done: number; total?: number; file?: string }[] = [];
  try {
    const snapshot = await buildSnapshot({
      project,
      home: root,
      os: "linux",
      name: "laptop",
      peerName: "desk",
      target: { os: "linux", home: root, project: join(root, "dest") },
      destPath: join(root, "dest"),
      sessionJsonl,
      entries: [],
      onProgress: (event) => events.push({ phase: event.phase, done: event.done, total: event.total, file: event.file }),
    });
    assert.ok(events.some((event) => event.phase === "listing" && event.file === "src/a.txt"));
    const reading = events.filter((event) => event.phase === "reading");
    assert.ok(reading.some((event) => event.file === "src/a.txt" && (event.done ?? 0) > 0 && event.done < (event.total ?? 0)));
    const last = reading.at(-1);
    const total = snapshot.files.reduce((sum, file) => sum + file.size, 0);
    assert.equal(last?.done, total);
    assert.equal(last?.total, total);
    assert.equal(last?.file, "session");
    const text = snapshot.files.find((file) => file.relative === "src/a.txt");
    assert.equal(text?.sha256, createHash("sha256").update("hello").digest("hex"));
    const empty = snapshot.files.find((file) => file.relative === "empty.txt");
    assert.equal(empty?.sha256, createHash("sha256").update("").digest("hex"));
    const link = snapshot.files.find((file) => file.relative === "src/link.txt");
    assert.equal(link?.symlink, "a.txt");
    assert.equal(link?.sha256, "");
    const session = snapshot.files.find((file) => file.kind === "session");
    assert.equal(session?.sha256, createHash("sha256").update(sessionJsonl).digest("hex"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, connect as connectTcp, type AddressInfo } from "node:net";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createIdentity } from "../src/core/crypto.ts";
import { handshakeListener, handshakeSender } from "../src/core/link.ts";
import type { SessionManifest } from "../src/core/manifest.ts";
import { receiveSession, sendPlan, type SendPlan, type SendProgress } from "../src/core/transfer.ts";

test("a dropped socket resumes from the last acked byte", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-teleport-"));
  const source = join(root, "source.bin");
  const payload = Buffer.alloc(1000);
  for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
  await writeFile(source, payload);
  const session = Buffer.from(
    `${JSON.stringify({ type: "session", version: 3, id: "abc", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/home/ada/work/app" })}\n${JSON.stringify({ type: "message", id: "a1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } })}\n`,
  );
  const dest = join(root, "dest-project");
  const home = homedir();
  const manifest: SessionManifest = {
    version: 1,
    source: { os: "linux", home, project: join(root, "project"), name: "source" },
    target: { os: "linux", home, project: dest, name: "target" },
    destPath: dest,
    toolsUsed: [{ name: "node", kind: "binary", evidence: "node --version" }],
    externalFileCount: 0,
    note: "Installed tools and services (Node, Docker, databases, binaries on PATH) were used and were not copied.",
    createdAt: new Date().toISOString(),
  };
  const plan: SendPlan = {
    transferId: randomUUID(),
    destPath: dest,
    overwriteDest: false,
    manifest,
    skipSourcePaths: [],
    files: [
      {
        index: 0,
        kind: "project",
        size: payload.length,
        mode: 0o644,
        relative: "payload.bin",
        sha256: createHash("sha256").update(payload).digest("hex"),
        diskPath: source,
      },
      {
        index: 1,
        kind: "session",
        size: session.length,
        mode: 0o600,
        sha256: createHash("sha256").update(session).digest("hex"),
        bytes: session,
      },
    ],
  };

  const listenerKey = createIdentity();
  const senderKey = createIdentity();
  const openSockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    openSockets.add(socket);
    socket.on("close", () => openSockets.delete(socket));
    void (async () => {
      const accepted = await handshakeListener(socket, listenerKey, {
        name: "target",
        os: "linux",
        home,
        code: "ABCD2345",
      }, (publicKey) => publicKey === senderKey.publicKey);
      await receiveSession(accepted.link, {
        stateRoot: join(root, "state"),
        sessionsRoot: join(root, "sessions"),
        home,
        os: "linux",
        exists: async () => false,
        launch: async (sessionFile) => ({ started: false, command: `pi --session ${sessionFile}` }),
      });
    })().catch(() => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;

  const dial = async () => {
    const socket = connectTcp(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    return handshakeSender(socket, senderKey, { name: "source" });
  };

  try {
    const firstProgress: SendProgress[] = [];
    const first = await dial();
    await assert.rejects(() => sendPlan(first.link, plan, {
      chunkSize: 100,
      dropAfterChunks: 1,
      onProgress: (event) => firstProgress.push(event),
    }), /dropped/);
    assert.equal(firstProgress.at(-1)?.phase, "sending");
    assert.equal(firstProgress.at(-1)?.done, 100);
    assert.equal(firstProgress.at(-1)?.file, "payload.bin");
    const secondProgress: SendProgress[] = [];
    const second = await dial();
    const result = await sendPlan(second.link, plan, {
      chunkSize: 100,
      resume: true,
      onProgress: (event) => secondProgress.push(event),
    });
    assert.equal(secondProgress[0]?.done, 100);
    assert.equal(secondProgress.at(-1)?.phase, "writing");
    assert.equal(secondProgress.at(-1)?.done, payload.length + session.length);
    assert.ok(secondProgress.some((event) => event.file === "session"));
    assert.ok(result.bytesSent < payload.length + session.length);
    assert.ok(result.bytesSent > 0);
    const restored = await readFile(join(dest, "payload.bin"));
    assert.deepEqual(restored, payload);
    const sessionText = await readFile(result.sessionFile, "utf8");
    assert.match(sessionText, /"cwd":/);
    assert.match(sessionText, new RegExp(dest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(result.launched, false);
    assert.match(result.launchCommand ?? "", /^pi --session /);
  } finally {
    for (const socket of openSockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

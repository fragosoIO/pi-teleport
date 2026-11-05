import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startListener } from "../src/listener.ts";

test("the listener answers on localhost and shows a one-time code", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-teleport-listen-"));
  await writeFile(join(root, "config.json"), JSON.stringify({
    name: "laptop",
    listenPort: 0,
    beaconPort: 0,
    controlPort: 0,
    pairings: {},
  }));
  const listener = await startListener({ root, home: root });
  try {
    assert.equal(listener.code.length, 8);
    const status = await getJson(listener.controlPort, "/v1/status");
    assert.equal(status.name, "laptop");
    assert.equal(status.code, listener.code);
    assert.equal(typeof status.publicKey, "string");
  } finally {
    await listener.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a service beacon is visible without a one-time code", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-teleport-beacon-"));
  await writeFile(join(root, "config.json"), JSON.stringify({
    name: "laptop",
    listenPort: 0,
    beaconPort: 0,
    controlPort: 0,
    pairings: {},
  }));
  const listener = await startListener({ root, home: root });
  const socket = createSocket("udp4");
  try {
    const payload = Buffer.from(JSON.stringify({
      v: 1,
      name: "desktop",
      pub: "peer-key",
      port: 49721,
      lan: ["10.0.0.8"],
      ts: [],
    }));
    await new Promise<void>((resolve, reject) => {
      socket.send(payload, listener.beaconPort, "127.0.0.1", (error) => error ? reject(error) : resolve());
    });
    let names: string[] = [];
    for (let attempt = 0; attempt < 20 && !names.includes("desktop"); attempt += 1) {
      const peers = await getJson(listener.controlPort, "/v1/peers") as unknown as { name: string }[];
      names = peers.map((peer) => peer.name);
      if (!names.includes("desktop")) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(names.includes("desktop"));
  } finally {
    socket.close();
    await listener.close();
    await rm(root, { recursive: true, force: true });
  }
});

function getJson(port: number, path: string): Promise<{ name: string; code: string; publicKey: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
    });
    req.on("error", reject);
    req.end();
  });
}

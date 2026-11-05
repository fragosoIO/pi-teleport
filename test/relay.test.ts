import assert from "node:assert/strict";
import { once } from "node:events";
import { connect as connectTcp, createServer } from "node:net";
import test from "node:test";

import { createIdentity } from "../src/core/crypto.ts";
import { dialRelay } from "../src/core/dial.ts";
import { handshakeListener, handshakeSender } from "../src/core/link.ts";
import { readLine, writeLine } from "../src/core/lines.ts";
import { startRelay } from "../src/relay.ts";

test("the relay pairs two listeners and copies bytes without reading a payload", async () => {
  const server = startRelay(0, "127.0.0.1");
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("relay did not bind");

  const listener = connectTcp(address.port, "127.0.0.1");
  let sender: ReturnType<typeof connectTcp> | undefined;
  try {
    await once(listener, "connect");
    writeLine(listener, { t: "register", name: "laptop", pubkey: "abc", code: "ABCD2345" });
    assert.equal(JSON.parse(await readLine(listener)).t, "registered");

    sender = connectTcp(address.port, "127.0.0.1");
    await once(sender, "connect");
    writeLine(sender, { t: "connect", code: "ABCD2345" });
    assert.equal(JSON.parse(await readLine(sender)).t, "bridge");
    assert.equal(JSON.parse(await readLine(listener)).t, "bridge");

    writeLine(sender, { t: "payload", secret: "not-for-the-relay" });
    const forwarded = JSON.parse(await readLine(listener)) as { secret?: string };
    assert.equal(forwarded.secret, "not-for-the-relay");
  } finally {
    sender?.destroy();
    listener.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an encrypted handshake still runs after the relay line exchange", async () => {
  const server = startRelay(0, "127.0.0.1");
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("relay did not bind");

  const listenerKey = createIdentity();
  const senderKey = createIdentity();
  const listener = connectTcp(address.port, "127.0.0.1");
  try {
    await once(listener, "connect");
    writeLine(listener, { t: "register", name: "laptop", pubkey: listenerKey.publicKey, code: "ABCD2345" });
    assert.equal(JSON.parse(await readLine(listener)).t, "registered");

    const accepted = (async () => {
      const bridged = JSON.parse(await readLine(listener)) as { t?: string };
      assert.equal(bridged.t, "bridge");
      return handshakeListener(listener, listenerKey, {
        name: "laptop",
        os: "linux",
        home: "/home/ada",
        code: "ABCD2345",
      }, (publicKey) => publicKey === senderKey.publicKey);
    })();

    const dialed = await dialRelay("127.0.0.1", address.port, senderKey, { name: "desk", code: "ABCD2345" }, { code: "ABCD2345" });
    dialed.link.sendJson({ t: "ping" });
    const handshake = await accepted;
    const ping = await handshake.link.nextJson();
    assert.equal(ping.t, "ping");
    dialed.link.finish();
    handshake.link.finish();
  } finally {
    listener.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("accept all completes a handshake with no code and no saved key", async () => {
  const listenerKey = createIdentity();
  const senderKey = createIdentity();
  const server = createServer((socket) => {
    void handshakeListener(socket, listenerKey, {
      name: "laptop",
      os: "linux",
      home: "/home/ada",
      projects: "/home/ada/Projects",
      code: "ABCD2345",
      requireCode: false,
    }, () => false).then((accepted) => accepted.link.finish()).catch(() => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener did not bind");
  const socket = connectTcp(address.port, "127.0.0.1");
  try {
    await once(socket, "connect");
    const opened = await handshakeSender(socket, senderKey, { name: "desk" });
    assert.equal(opened.peer.name, "laptop");
    opened.link.finish();
  } finally {
    socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a listener that requires a code rejects an unknown sender", async () => {
  const listenerKey = createIdentity();
  const senderKey = createIdentity();
  const server = createServer((socket) => {
    void handshakeListener(socket, listenerKey, {
      name: "laptop",
      os: "linux",
      home: "/home/ada",
      code: "ABCD2345",
      requireCode: true,
    }, () => false).catch(() => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener did not bind");
  const socket = connectTcp(address.port, "127.0.0.1");
  try {
    await once(socket, "connect");
    await assert.rejects(() => handshakeSender(socket, senderKey, { name: "desk" }), /pairing code or saved key required/);
  } finally {
    socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

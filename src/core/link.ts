import { once } from "node:events";
import type { Socket } from "node:net";

import { createIdentity, deriveSessionKey, type Identity } from "./crypto.ts";
import type { OsName } from "./paths.ts";
import { decodePlain, decodeSecure, encodePlain, encodeSecure, FrameBuffer, type Incoming, type JsonMessage } from "./wire.ts";

export interface Hello {
  t: "hello";
  role: "sender" | "listener";
  name: string;
  staticPub: string;
  ephPub: string;
  os?: OsName;
  home?: string;
  code?: string;
}

export class PeerLink {
  private frames = new FrameBuffer();
  /** Complete frames, decoded only when read so the key can be installed first. */
  private pending: Buffer[] = [];
  private wake: (() => void) | null = null;
  private closedError: Error | null = null;
  private key: Buffer | null = null;
  private socket: Socket;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      try {
        this.pending.push(...this.frames.push(chunk));
        this.wake?.();
      } catch (error) {
        this.break(error as Error);
      }
    });
    socket.on("error", (error) => this.break(error));
    socket.on("close", () => this.break(new Error("connection closed")));
    // readLine leaves the socket paused. A new "data" listener does not
    // resume a stream that was explicitly paused, so pull any buffered bytes.
    socket.resume();
  }

  setKey(key: Buffer): void {
    this.key = key;
  }

  sendJson(value: JsonMessage): void {
    const frame = this.key ? encodeSecure(this.key, { kind: "json", value }) : encodePlain(value);
    this.socket.write(frame);
  }

  sendChunk(fileIndex: number, offset: number, data: Buffer): void {
    if (!this.key) throw new Error("channel is not encrypted yet");
    this.socket.write(encodeSecure(this.key, { kind: "chunk", fileIndex, offset, data }));
  }

  async next(): Promise<Incoming> {
    while (this.pending.length === 0) {
      if (this.closedError) throw this.closedError;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
    const frame = this.pending.shift();
    if (!frame) throw new Error("missing frame");
    if (!this.key) return { kind: "json", value: decodePlain(frame) };
    return decodeSecure(this.key, frame);
  }

  async nextJson(): Promise<JsonMessage> {
    const message = await this.next();
    if (message.kind !== "json") throw new Error("expected a control message");
    return message.value;
  }

  /** Flush and close. Used after a finished transfer so the process can exit. */
  finish(): void {
    if (!this.socket.destroyed) this.socket.end();
  }

  close(): void {
    this.socket.destroy();
  }

  private break(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    this.wake?.();
  }
}

export interface HandshakeResult {
  link: PeerLink;
  peer: Hello;
  code: string;
}

/** Dial side. `code` is empty when the peer is already paired. */
export async function handshakeSender(
  socket: Socket,
  identity: Identity,
  hello: { name: string; code?: string; expectPub?: string },
): Promise<HandshakeResult> {
  const link = new PeerLink(socket);
  const eph = createIdentity();
  const code = hello.code ?? "";
  link.sendJson({
    t: "hello",
    role: "sender",
    name: hello.name,
    staticPub: identity.publicKey,
    ephPub: eph.publicKey,
    code: code || undefined,
  });
  const reply = await link.nextJson();
  if (reply.t === "reject") throw new Error(String(reply.reason ?? "rejected"));
  if (reply.t !== "hello") throw new Error("expected a handshake reply");
  const peer = reply as unknown as Hello;
  if (hello.expectPub && peer.staticPub !== hello.expectPub) {
    link.close();
    throw new Error("peer key does not match the saved pairing");
  }
  const key = deriveSessionKey(identity, eph, peer.staticPub, peer.ephPub, code);
  link.setKey(key);
  link.sendJson({ t: "open", name: hello.name });
  return { link, peer, code };
}

export async function handshakeListener(
  socket: Socket,
  identity: Identity,
  info: { name: string; os: OsName; home: string; code: string },
  knownKey: (publicKey: string) => boolean,
): Promise<HandshakeResult> {
  const link = new PeerLink(socket);
  const first = await link.nextJson();
  if (first.t !== "hello") throw new Error("expected a handshake");
  const peer = first as unknown as Hello;
  const presented = peer.code ?? "";
  if (presented && presented !== info.code) {
    link.sendJson({ t: "reject", reason: "one-time code does not match" });
    link.close();
    throw new Error("rejected sender");
  }
  const viaCode = presented.length > 0 && presented === info.code;
  if (!viaCode && !knownKey(peer.staticPub)) {
    link.sendJson({ t: "reject", reason: "pairing code or saved key required" });
    link.close();
    throw new Error("rejected sender");
  }
  const eph = createIdentity();
  link.sendJson({
    t: "hello",
    role: "listener",
    name: info.name,
    staticPub: identity.publicKey,
    ephPub: eph.publicKey,
    os: info.os,
    home: info.home,
  });
  // Mix the code only when the sender presented the current one. A saved pairing uses "".
  const mixed = viaCode ? presented : "";
  const key = deriveSessionKey(identity, eph, peer.staticPub, peer.ephPub, mixed);
  link.setKey(key);
  const open = await link.nextJson();
  if (open.t !== "open") throw new Error("encrypted handshake failed");
  return { link, peer, code: mixed };
}

export function waitForConnect(socket: Socket): Promise<void> {
  if (!socket.connecting) return Promise.resolve();
  return once(socket, "connect").then(() => undefined);
}

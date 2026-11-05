import { open, seal } from "./crypto.ts";

const MAX_FRAME = 64 * 1024 * 1024;

export interface JsonMessage {
  t: string;
  [key: string]: unknown;
}

export type Incoming =
  | { kind: "json"; value: JsonMessage }
  | { kind: "chunk"; fileIndex: number; offset: number; data: Buffer };

export class FrameBuffer {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: Buffer[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > MAX_FRAME) throw new Error("frame exceeds 64MB");
      if (this.buf.length < 4 + len) break;
      frames.push(this.buf.subarray(4, 4 + len));
      this.buf = this.buf.subarray(4 + len);
    }
    return frames;
  }
}

export function encodeFrame(payload: Buffer): Buffer {
  const out = Buffer.alloc(4 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  payload.copy(out, 4);
  return out;
}

export function encodePlain(value: JsonMessage): Buffer {
  return encodeFrame(Buffer.from(JSON.stringify(value)));
}

export function decodePlain(frame: Buffer): JsonMessage {
  const value = JSON.parse(frame.toString("utf8")) as JsonMessage;
  if (!value || typeof value.t !== "string") throw new Error("frame is not a message");
  return value;
}

export function encodeSecure(key: Buffer, message: Incoming): Buffer {
  let plain: Buffer;
  if (message.kind === "json") {
    plain = Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(message.value))]);
  } else {
    const head = Buffer.alloc(17);
    head.writeUInt8(2, 0);
    head.writeUInt32BE(message.fileIndex, 1);
    head.writeBigUInt64BE(BigInt(message.offset), 5);
    head.writeUInt32BE(message.data.length, 13);
    plain = Buffer.concat([head, message.data]);
  }
  return encodeFrame(seal(key, plain));
}

export function decodeSecure(key: Buffer, frame: Buffer): Incoming {
  const plain = open(key, frame);
  const kind = plain.readUInt8(0);
  if (kind === 1) {
    const value = JSON.parse(plain.subarray(1).toString("utf8")) as JsonMessage;
    return { kind: "json", value };
  }
  if (kind === 2) {
    const fileIndex = plain.readUInt32BE(1);
    const offset = Number(plain.readBigUInt64BE(5));
    const len = plain.readUInt32BE(13);
    const data = plain.subarray(17, 17 + len);
    if (data.length !== len) throw new Error("short chunk");
    return { kind: "chunk", fileIndex, offset, data: Buffer.from(data) };
  }
  throw new Error(`unknown message kind ${kind}`);
}

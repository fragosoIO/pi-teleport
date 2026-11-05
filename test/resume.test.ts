import assert from "node:assert/strict";
import test from "node:test";

import { initialCursors, isTransferComplete, nextPayloadSlice, noteChunk, resumeCursor } from "../src/core/resume.ts";

test("a dropped transfer resumes at the last contiguous byte", () => {
  const payload = new Uint8Array(1000);
  for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
  let files = initialCursors([payload.byteLength, 50]);
  const chunkSize = 300;

  const first = nextPayloadSlice(payload, files[0].received, chunkSize);
  assert.ok(first);
  assert.equal(first.offset, 0);
  files = noteChunk(files, 0, first.offset, first.bytes.byteLength);
  assert.equal(files[0].received, 300);

  // The connection drops here. The next slice starts where the bytes stopped.
  const point = resumeCursor(files);
  assert.deepEqual(point, { fileIndex: 0, offset: 300 });
  const second = nextPayloadSlice(payload, point.offset, chunkSize);
  assert.ok(second);
  assert.equal(second.offset, 300);

  const assembled = new Uint8Array(payload.byteLength);
  assembled.set(first.bytes, first.offset);
  assembled.set(second.bytes, second.offset);
  files = noteChunk(files, 0, second.offset, second.bytes.byteLength);

  while (!isTransferComplete([files[0]])) {
    const cursor = resumeCursor(files);
    assert.ok(cursor);
    const slice = nextPayloadSlice(payload, cursor.offset, chunkSize);
    assert.ok(slice);
    assembled.set(slice.bytes, slice.offset);
    files = noteChunk(files, 0, slice.offset, slice.bytes.byteLength);
  }
  assert.deepEqual(assembled, payload);
  assert.deepEqual(resumeCursor(files), { fileIndex: 1, offset: 0 });
});

test("duplicate chunks are ignored and a gap is rejected", () => {
  let files = initialCursors([100]);
  files = noteChunk(files, 0, 0, 40);
  const again = noteChunk(files, 0, 0, 40);
  assert.equal(again[0].received, 40);
  assert.throws(() => noteChunk(files, 0, 50, 10), /gap/);
  files = noteChunk(files, 0, 40, 60);
  assert.equal(isTransferComplete(files), true);
  assert.equal(resumeCursor(files), null);
});

test("resume continues on the next file after the first one is complete", () => {
  let files = initialCursors([10, 10]);
  files = noteChunk(files, 0, 0, 10);
  files = noteChunk(files, 1, 0, 4);
  assert.deepEqual(resumeCursor(files), { fileIndex: 1, offset: 4 });
  files = noteChunk(files, 1, 4, 6);
  assert.equal(isTransferComplete(files), true);
});

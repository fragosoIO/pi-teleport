/**
 * A dropped transfer continues from the last contiguous byte of each file.
 * Duplicate chunks are ignored. A gap is an error, not a silent skip.
 */

export interface FileCursor {
  size: number;
  received: number;
}

export interface ResumePoint {
  fileIndex: number;
  offset: number;
}

export function initialCursors(sizes: readonly number[]): FileCursor[] {
  return sizes.map((size) => {
    if (size < 0) throw new Error("file size must be >= 0");
    return { size, received: 0 };
  });
}

/** First incomplete file, or null when every file has been received. */
export function resumeCursor(files: readonly FileCursor[]): ResumePoint | null {
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (file.received < file.size) return { fileIndex: index, offset: file.received };
  }
  return null;
}

export function isTransferComplete(files: readonly FileCursor[]): boolean {
  return resumeCursor(files) === null;
}

/**
 * Record a chunk. `offset` is the byte position inside that file.
 * A chunk that is already fully inside the received prefix is a duplicate.
 */
export function noteChunk(files: readonly FileCursor[], fileIndex: number, offset: number, length: number): FileCursor[] {
  if (fileIndex < 0 || fileIndex >= files.length) throw new Error(`unknown file ${fileIndex}`);
  if (length < 0) throw new Error("chunk length must be >= 0");
  const file = files[fileIndex];
  if (offset < 0) throw new Error("negative offset");
  if (offset < file.received) {
    if (offset + length <= file.received) return files.slice();
    throw new Error(`overlapping gap at ${file.received}, chunk starts at ${offset}`);
  }
  if (offset > file.received) throw new Error(`gap: file ${fileIndex} has ${file.received} bytes, chunk starts at ${offset}`);
  const received = file.received + length;
  if (received > file.size) throw new Error(`chunk exceeds file ${fileIndex} (${file.size} bytes)`);
  const next = files.slice();
  next[fileIndex] = { size: file.size, received };
  return next;
}

/** Bytes still to send for one file, sliced from `payload` at the resume offset. */
export function nextPayloadSlice(
  payload: Uint8Array,
  received: number,
  chunkSize: number,
): { offset: number; bytes: Uint8Array } | null {
  if (chunkSize < 1) throw new Error("chunkSize must be positive");
  if (received >= payload.byteLength) return null;
  if (received < 0) throw new Error("negative offset");
  const end = Math.min(payload.byteLength, received + chunkSize);
  return { offset: received, bytes: payload.subarray(received, end) };
}

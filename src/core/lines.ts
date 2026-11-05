import type { Socket } from "node:net";

/**
 * Read one UTF-8 line. Uses readable mode so bytes that arrived while no
 * listener was attached are still pulled from the kernel. Extra bytes stay
 * on the socket for the next reader.
 */
export function readLine(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const cleanup = () => {
      socket.off("readable", onReadable);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("connection closed"));
    };
    const onReadable = () => {
      for (;;) {
        const chunk = socket.read() as Buffer | null;
        if (!chunk) break;
        buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      }
      const newline = buf.indexOf(0x0a);
      if (newline < 0) return;
      cleanup();
      const line = buf.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      const extra = buf.subarray(newline + 1);
      if (extra.length > 0) socket.unshift(extra);
      resolve(line);
    };
    socket.on("readable", onReadable);
    socket.on("error", onError);
    socket.on("close", onClose);
    onReadable();
  });
}

export function writeLine(socket: Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`);
}

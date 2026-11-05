import { createServer, type Server, type Socket } from "node:net";

import { RELAY_PORT } from "./core/constants.ts";
import { readLine, writeLine } from "./core/lines.ts";

/**
 * Both listeners dial this program. It pairs them by short name or one-time
 * code and then copies bytes. It cannot read the transfer: the payload is
 * encrypted before it is written to the socket.
 */
export function startRelay(port = RELAY_PORT, host = "0.0.0.0"): Server {
  const waiting = new Map<string, Socket>();
  const server = createServer((socket) => {
    void handle(socket).catch(() => socket.destroy());
  });

  async function handle(socket: Socket): Promise<void> {
    const line = await readLine(socket);
    const message = JSON.parse(line) as { t?: string; name?: string; code?: string; pubkey?: string };
    if (message.t === "register") {
      const keys = [`name:${message.name ?? ""}`];
      if (message.code) keys.push(`code:${message.code}`);
      for (const key of keys) {
        const previous = waiting.get(key);
        if (previous && previous !== socket) previous.destroy();
        waiting.set(key, socket);
      }
      const drop = () => {
        for (const key of keys) {
          if (waiting.get(key) === socket) waiting.delete(key);
        }
      };
      socket.on("close", drop);
      writeLine(socket, { t: "registered" });
      return;
    }
    if (message.t === "connect") {
      const key = message.code ? `code:${message.code}` : `name:${message.name ?? ""}`;
      const peer = waiting.get(key);
      if (!peer || peer.destroyed) {
        writeLine(socket, { t: "error", message: "that computer is not connected to the relay" });
        socket.end();
        return;
      }
      for (const [saved, current] of waiting) {
        if (current === peer) waiting.delete(saved);
      }
      writeLine(peer, { t: "bridge" });
      writeLine(socket, { t: "bridge" });
      peer.pipe(socket);
      socket.pipe(peer);
      peer.on("close", () => socket.destroy());
      socket.on("close", () => peer.destroy());
      return;
    }
    writeLine(socket, { t: "error", message: "unknown relay message" });
    socket.end();
  }

  server.listen(port, host);
  return server;
}

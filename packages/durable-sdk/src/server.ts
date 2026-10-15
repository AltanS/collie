// The durable socket wire, version 1, over one Unix socket, mode 0600 in a directory with mode 0700, in Bun. No
// token: the socket is the gate. The wire itself is `core.handle` (core/handle.ts); this file is the transport. The
// requests are parsed by node:http (http.ts, shared with the Node entry); the connections are accepted by
// Bun.listen, because only that gives the fd that tells who the peer is (peer.ts).
// A caller that is the program itself or its descendant may read but not act (403 caller-refused).
// Node has no way to that fd: `../node/index.ts` serves the same wire without the descendant check.

import { rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { dirname } from "node:path";
import { Conn } from "./conn.ts";
import type { CollieCore } from "./core/index.ts";
import { HttpError } from "./core/receipts.ts";
import { wireListener } from "./http.ts";
import { peerCredsAvailable } from "./peer.ts";
import { assertPrivateSocket, checkSocketPath, clearStaleSocket, preparePrivateDir, withNarrowUmask } from "./socket.ts";

export interface ServerOptions {
  core: CollieCore;
  /**
   * The same-user defence. `descendant` (the default): every act (`answer`, `send`, `abort`, `action`, `rename`,
   * `close`, `reopen` and starters) is refused with 403 `caller-refused` when the caller is the program itself or one
   * of its descendants, or cannot be told apart from one. Reads stay open. It needs Bun on Linux. Where it cannot read the peer, the start fails; `off` is the
   * program's explicit choice to run without it.
   */
  callerCheck?: "descendant" | "off";
}

export interface Running {
  /** The socket path. */
  address: string;
  /** Stop taking connections, let the replies in flight go out (at most 2 s), then cut what is left. */
  close(): Promise<void>;
}

export async function startServer(socketPath: string, o: ServerOptions): Promise<Running> {
  const { core } = o;
  const path = checkSocketPath(socketPath);
  const callerCheck = o.callerCheck ?? "descendant";
  if (callerCheck === "descendant" && !peerCredsAvailable()) {
    throw new Error('the descendant check needs Bun on Linux to read the peer of a socket; pass callerCheck: "off" to run without it');
  }

  /** 403 for a caller that is the program or below it. Every act calls this; reads never do. */
  function refuseOwnCaller(req: IncomingMessage) {
    if (callerCheck === "off") return;
    const relation = req.socket instanceof Conn ? req.socket.relation : "unknown";
    if (relation === "other") return;
    const message = relation === "unknown" ? "the caller could not be told apart from the program or its tools" : "the caller is the program itself or one of its descendants";
    throw new HttpError(403, "caller-refused", { message });
  }

  const wire = wireListener(core, refuseOwnCaller);
  const server: Server = createServer(wire.listener);

  // The folder is 0700 and ours, or the start stops. A dead socket file goes; a live one is another instance.
  preparePrivateDir(dirname(path));
  await clearStaleSocket(path);
  const open = new Set<Conn>();
  const listener = withNarrowUmask(() =>
    Bun.listen<Conn>({
      unix: path,
      socket: {
        open(sock) {
          const conn = new Conn(sock);
          sock.data = conn;
          open.add(conn);
          conn.once("close", () => open.delete(conn));
          conn.on("error", () => {}); // a reset peer is the peer's business
          server.emit("connection", conn);
        },
        data(sock, chunk) {
          sock.data.feed(chunk);
        },
        drain(sock) {
          sock.data.drain();
        },
        end(sock) {
          sock.data.finish();
        },
        close(sock) {
          sock.data.destroy();
        },
        error(sock, err) {
          sock.data.destroy(err);
        },
      },
    }),
  );
  try {
    assertPrivateSocket(path);
  } catch (e) {
    listener.stop(true);
    throw e;
  }

  return {
    address: path,
    close: async () => {
      // No new connection from here on. A reply already on its way (the phone's answer, just before the program
      // exits) still goes out, so the phone hears "taken" and not a hang-up.
      listener.stop(false);
      await wire.drained();
      for (const c of open) c.destroy();
      rmSync(path, { force: true }); // its own socket goes on a clean exit
    },
  };
}

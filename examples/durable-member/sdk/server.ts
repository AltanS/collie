// The durable socket wire, version 1, over one Unix socket, mode 0600 in a directory with mode 0700. No token:
// the socket is the gate. The wire itself is `core.handle` (core/handle.ts); this file is the transport. The
// requests are parsed by node:http; the connections are accepted by Bun.listen, because only that gives the fd
// that tells who the peer is (peer.ts).
// A caller that is the program itself or its descendant may read but not act (403 caller-refused).

import { rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { Conn } from "./conn.ts";
import type { CollieCore } from "./core/index.ts";
import { HttpError } from "./core/receipts.ts";
import { peerCredsAvailable } from "./peer.ts";
import { assertPrivateSocket, checkSocketPath, clearStaleSocket, preparePrivateDir, withNarrowUmask } from "./socket.ts";

export interface ServerOptions {
  core: CollieCore;
  /**
   * The same-user defence. `descendant` (the default): `answer`, `send`, `abort` and starters are refused with 403
   * `caller-refused` when the caller is the program itself or one of its descendants, or cannot be told apart from
   * one. Reads stay open. It needs Bun on Linux. Where it cannot read the peer, the start fails; `off` is the
   * program's explicit choice to run without it.
   */
  callerCheck?: "descendant" | "off";
}

export interface Running {
  /** The socket path. */
  address: string;
  close(): Promise<void>;
}

/** node:http's request as a web `Request`. The body streams through, so the core's 64 KiB cap reads it once. */
function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(new URL(req.url ?? "/", "http://localhost").href, {
    method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: "half" } : {}),
  } as RequestInit);
}

async function send(res: ServerResponse, response: Response) {
  const body = Buffer.from(await response.arrayBuffer());
  const headers: Record<string, string> = Object.fromEntries(response.headers);
  if (response.status !== 304) headers["content-length"] = String(body.length);
  res.writeHead(response.status, headers);
  res.end(response.status === 304 ? undefined : body);
}

export async function startServer(socketPath: string, o: ServerOptions): Promise<Running> {
  const { core } = o;
  const path = checkSocketPath(socketPath);
  const callerCheck = o.callerCheck ?? "descendant";
  if (callerCheck === "descendant" && !peerCredsAvailable()) {
    throw new Error('the descendant check needs Bun on Linux to read the peer of a socket; pass callerCheck: "off" to run without it');
  }

  /** 403 for a caller that is the program or below it. Only the four acts call this; reads never do. */
  function refuseOwnCaller(req: IncomingMessage) {
    if (callerCheck === "off") return;
    const relation = req.socket instanceof Conn ? req.socket.relation : "unknown";
    if (relation === "other") return;
    const message = relation === "unknown" ? "the caller could not be told apart from the program or its tools" : "the caller is the program itself or one of its descendants";
    throw new HttpError(403, "caller-refused", { message });
  }

  const server: Server = createServer((req, res) => {
    core
      .handle(toRequest(req), { refuseAct: () => refuseOwnCaller(req) })
      .then((response) => send(res, response))
      .catch((e) => {
        console.error("session server error:", e);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: "internal" }));
        }
      });
  });

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
      listener.stop(true);
      for (const c of open) c.destroy();
      rmSync(path, { force: true }); // its own socket goes on a clean exit
    },
  };
}

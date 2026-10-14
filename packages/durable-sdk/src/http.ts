// The wire over node:http, for any host. `core.handle` is a web `Request` in and a `Response` out; this file plugs it
// into a node:http server, which both Bun and Node run. A host that serves web requests itself (Bun's `serve`, a
// Worker) passes `core.handle` straight to it and needs nothing here. No Bun import: the Node entry uses this file.

import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { CollieCore } from "./core/index.ts";

/** How long `close()` waits for the replies in flight before it cuts the connections. */
export const DRAIN_MS = 2000;

/** node:http's request as a web `Request`. The body streams through, so the core's 64 KiB cap reads it once. */
export function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
  const method = req.method ?? "GET";
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req);
    init.duplex = "half";
  }
  return new Request(new URL(req.url ?? "/", "http://localhost").href, init);
}

/** A web `Response` written to node:http's response. */
export async function send(res: ServerResponse, response: Response): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer());
  const headers: Record<string, string> = Object.fromEntries(response.headers);
  if (response.status !== 304) headers["content-length"] = String(body.length);
  res.writeHead(response.status, headers);
  res.end(response.status === 304 ? undefined : body);
}

/** The wire as a node:http request listener, with a count of the replies still on their way. */
export interface WireListener {
  readonly listener: RequestListener;
  /** Resolves once every reply in flight has gone out, or after `ms`, whichever is first. */
  drained(ms?: number): Promise<void>;
}

/**
 * Serve `core` through node:http: `createServer(wireListener(core).listener)`. `refuseAct`, when the host can tell who
 * calls, throws 403 `caller-refused` for a caller that may read but not act (WIRE.md 1A); it gets the request.
 */
export function wireListener(core: CollieCore, refuseAct?: (req: IncomingMessage) => void): WireListener {
  let inFlight = 0;
  const idle = new Set<() => void>();
  const done = () => {
    inFlight -= 1;
    // A Set walk survives `wake` deleting the entry it stands on.
    if (inFlight === 0) for (const wake of idle) wake();
  };
  const listener: RequestListener = (req, res) => {
    inFlight += 1;
    let counted = true;
    const finish = () => {
      if (!counted) return;
      counted = false;
      done();
    };
    res.once("finish", finish);
    res.once("close", finish);
    core
      .handle(toRequest(req), refuseAct === undefined ? {} : { refuseAct: () => refuseAct(req) })
      .then((response) => send(res, response))
      .catch((e) => {
        console.error("session server error:", e);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: "internal" }));
        }
      });
  };
  return {
    listener,
    drained(ms = DRAIN_MS) {
      if (inFlight === 0) return Promise.resolve();
      // One `wake` per call: the timer and the idle walk both call it, and whichever comes first cancels the other.
      const { promise, resolve } = Promise.withResolvers<void>();
      const wake = () => {
        clearTimeout(timer);
        idle.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      idle.add(wake);
      return promise;
    },
  };
}

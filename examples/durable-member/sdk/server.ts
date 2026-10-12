// The durable socket wire, version 1. One Unix socket, mode 0600 in a directory with mode 0700. No token: the
// socket is the gate. The requests are served by node:http; the connections are accepted by Bun.listen, because
// only that gives the fd that tells who the peer is (peer.ts).
// Check order: version (409 incompatible), then hello, then ready (503 starting), then the route (404).
// A caller that is the program itself or its descendant may read but not act (403 caller-refused).

import { rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { Conn } from "./conn.ts";
import { digestOf, HttpError } from "./errors.ts";
import { BadAnswer, type Pane, type Store } from "./layout.ts";
import { peerCredsAvailable } from "./peer.ts";
import { assertId, bytes, CAPS, cut, idOk } from "./rules.ts";
import { assertPrivateSocket, checkSocketPath, clearStaleSocket, preparePrivateDir, withNarrowUmask } from "./socket.ts";
import {
  type AbortRequest,
  type AnswerReply,
  type AnswerRequest,
  type Caps,
  type ControlReply,
  type EventsReply,
  type Hello,
  PROTOCOL_RANGE,
  type SendRequest,
  type StarterReply,
} from "./types.ts";

export interface ServerOptions {
  store: Store;
  hostName: string;
  /** Defaults: everything the SDK can do is true, `terminal` is false. */
  caps?: Partial<Caps>;
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

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
};

/** A body is one JSON object. Over 64 KiB is 413: the rest is read and dropped so the client sees the answer. */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size <= CAPS.body) chunks.push(c as Buffer);
  }
  if (size > CAPS.body) throw new HttpError(413, "too-large");
  if (size === 0) return {};
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "bad-json");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "bad-body", { message: "the body is one JSON object" });
  return body as Record<string, unknown>;
}

const badBody = (why: string) => new HttpError(400, "bad-body", { message: cut(why, CAPS.message) });

/** A field that is present, a string, and follows the id rule. Missing or not a string: bad-body. Breaks the rule: bad-id. */
function idField(body: Record<string, unknown>, name: string): string {
  const v = body[name];
  if (typeof v !== "string") throw badBody(`${name} must be a string`);
  if (!idOk(v)) throw new HttpError(400, "bad-id", { message: `${name} breaks the id rule` });
  return v;
}

/** Exactly one of `turnId` and `askId`. */
function targetOf(body: Record<string, unknown>): { turnId: string } | { askId: string } {
  const hasTurn = body.turnId !== undefined && body.turnId !== null;
  const hasAsk = body.askId !== undefined && body.askId !== null;
  if (hasTurn === hasAsk) throw badBody("exactly one of turnId and askId");
  return hasTurn ? { turnId: idField(body, "turnId") } : { askId: idField(body, "askId") };
}

/** 409 `stale` with the pane's current turn and open ask ids. */
function stale(pane: Pane, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(409, "stale", { turnId: pane.turnId, askIds: pane.openAskIds, ...extra });
}

function checkTarget(pane: Pane, t: { turnId: string } | { askId: string }) {
  if ("turnId" in t ? t.turnId !== pane.turnId : !pane.asks.has(t.askId)) throw stale(pane);
}

const decode = (s: string): string | undefined => {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
};

export async function startServer(socketPath: string, o: ServerOptions): Promise<Running> {
  const { store } = o;
  const path = checkSocketPath(socketPath);
  const callerCheck = o.callerCheck ?? "descendant";
  if (callerCheck === "descendant" && !peerCredsAvailable()) {
    throw new Error('the descendant check needs Bun on Linux to read the peer of a socket; pass callerCheck: "off" to run without it');
  }
  const caps: Caps = { asks: true, starters: true, send: true, steer: true, abort: true, ...o.caps, terminal: false };
  const hello = (): Hello => ({
    service: "collie-durable",
    protocol: { ...PROTOCOL_RANGE },
    host: { name: cut(o.hostName, CAPS.hostName) },
    epoch: store.epoch,
    ready: store.ready,
    caps,
  });

  /** 403 for a caller that is the program or below it. Only the four acts call this; reads never do. */
  function refuseOwnCaller(req: IncomingMessage) {
    if (callerCheck === "off") return;
    const relation = req.socket instanceof Conn ? req.socket.relation : "unknown";
    if (relation === "other") return;
    const message = relation === "unknown" ? "the caller could not be told apart from the program or its tools" : "the caller is the program itself or one of its descendants";
    throw new HttpError(403, "caller-refused", { message });
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean); // session v1 ...
    if (parts[0] !== "session" || parts[1] !== "v1") return json(res, 404, { code: "not-found" });
    const route = parts.slice(2);

    // 1. Version. `hello` may come without a header (that is how a caller finds the range). Nothing else may.
    const header = req.headers["x-collie-session"];
    const version = header === undefined ? undefined : typeof header === "string" && /^\d+$/.test(header) ? Number(header) : Number.NaN;
    const inRange = version !== undefined && version >= PROTOCOL_RANGE.min && version <= PROTOCOL_RANGE.max;
    const isHello = route[0] === "hello" && route.length === 1;
    if (!(inRange || (isHello && version === undefined))) {
      return json(res, 409, { code: "incompatible", range: { ...PROTOCOL_RANGE } });
    }

    const method = req.method ?? "GET";
    // 2. hello
    if (method === "GET" && isHello) return json(res, 200, hello());
    // 3. ready
    if (!store.ready) return json(res, 503, { code: "starting" });

    // 4. the route
    if (method === "GET" && route[0] === "snapshot" && route.length === 1) {
      const snap = store.snapshot();
      const etag = `"${snap.epoch}-${snap.rev}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { etag });
        return res.end();
      }
      return json(res, 200, snap, { etag });
    }

    if (route[0] === "pane" && route.length === 3) {
      const verb = route[2];
      const want = verb === "events" ? "GET" : verb === "answer" || verb === "send" || verb === "abort" ? "POST" : undefined;
      if (method !== want) return json(res, 404, { code: "not-found" });
      const id = decode(route[1]!);
      const pane = id === undefined ? undefined : store.panes.get(id);
      if (!pane) return json(res, 404, { code: "no-such-pane" });

      if (verb === "events") {
        const afterText = url.searchParams.get("after");
        const epoch = url.searchParams.get("epoch");
        if (afterText === null || !/^\d+$/.test(afterText) || !Number.isSafeInteger(Number(afterText))) throw new HttpError(400, "bad-cursor");
        if (!epoch) throw new HttpError(400, "bad-cursor"); // a cursor means nothing without the epoch it came from
        const reply: EventsReply = { epoch: store.epoch, ...pane.eventsAfter(Number(afterText), epoch !== store.epoch) };
        return json(res, 200, reply);
      }

      refuseOwnCaller(req);
      const body = await readBody(req);
      const requestId = idField(body, "requestId");
      // The receipt is bound to the payload: the same id with another pane, ask, revision, option, note, turn or text is 409.
      const once = <T extends object>(payload: object, act: () => Promise<T>) => store.receipts.run(requestId, digestOf({ verb, pane: pane.id, ...payload }), act);

      if (verb === "answer") {
        const askId = idField(body, "askId");
        const { revision, answer } = body as Partial<AnswerRequest>;
        if (!Number.isSafeInteger(revision) || (revision as number) < 0) throw badBody("revision must be a non-negative integer");
        if (typeof answer !== "object" || answer === null || Array.isArray(answer)) throw badBody("answer must be an object");
        const optionId = idField(answer as unknown as Record<string, unknown>, "optionId");
        const note = (answer as { note?: unknown }).note;
        if (note !== undefined && note !== null && (typeof note !== "string" || bytes(note) > CAPS.note)) throw badBody("note must be a string of at most 2048 bytes");
        return json(
          res,
          200,
          await once<AnswerReply>({ askId, revision, optionId, note: typeof note === "string" ? note : null }, async () => {
            const open = pane.asks.get(askId);
            if (!open) return { result: "too-late" }; // answered, stopped, or from before a restart
            if (open.ask.revision !== revision) throw stale(pane, { ask: open.ask });
            try {
              const given = typeof note === "string" ? { optionId, note } : { optionId };
              return { result: pane.answer(askId, given) };
            } catch (e) {
              if (e instanceof BadAnswer) throw new HttpError(400, "bad-option");
              throw e;
            }
          }),
        );
      }

      if (verb === "send") {
        const target = targetOf(body);
        const { text, steer } = body as Partial<SendRequest>;
        if (typeof text !== "string" || text === "" || bytes(text) > CAPS.sendText) throw badBody("text must be 1 to 32768 bytes");
        if (steer !== undefined && steer !== null && typeof steer !== "boolean") throw badBody("steer must be a boolean");
        return json(
          res,
          200,
          await once<ControlReply>({ ...target, text, steer: steer === true }, async () => {
            if (!caps.send || !pane.canSend || (steer === true && !caps.steer)) throw new HttpError(409, "not-supported");
            checkTarget(pane, target); // the turn can move between the adapter's check and this one
            await pane.send(text, { steer: steer === true, requestId });
            return { ok: true };
          }),
        );
      }

      // abort
      const target = targetOf(body);
      return json(
        res,
        200,
        await once<ControlReply>(target, async () => {
          if (!caps.abort || !pane.canAbort) throw new HttpError(409, "not-supported");
          checkTarget(pane, target);
          if (pane.effective === "idle") return { ok: true }; // nothing runs: nothing to stop
          await pane.abort({ requestId });
          return { ok: true };
        }),
      );
    }

    if (method === "POST" && route[0] === "starter" && route.length === 2) {
      const id = decode(route[1]!);
      const starter = id === undefined ? undefined : store.starters.get(id);
      if (!starter) return json(res, 404, { code: "no-such-starter" });
      refuseOwnCaller(req);
      const body = await readBody(req);
      const requestId = idField(body, "requestId");
      if (!caps.starters) throw new HttpError(409, "not-supported");
      return json(
        res,
        200,
        await store.receipts.run<StarterReply>(requestId, digestOf({ verb: "starter", starter: starter.id }), async () => {
          try {
            const { paneId } = await starter.run();
            assertId(paneId, "starter paneId");
            if (!store.panes.has(paneId)) throw new Error("the starter named a pane that is not in the layout");
            return { paneId };
          } catch (e) {
            throw new HttpError(422, "starter-failed", { message: cut(e instanceof Error ? e.message : String(e), CAPS.message) });
          }
        }),
      );
    }

    return json(res, 404, { code: "not-found" });
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (e instanceof HttpError) return json(res, e.status, { code: e.code, ...e.extra });
      console.error("session server error:", e);
      if (!res.headersSent) json(res, 500, { code: "internal" });
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

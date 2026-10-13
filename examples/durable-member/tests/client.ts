// A small test client for the wire. It dials the socket the way Collie's `durable` adapter does (or, for a dial
// with a `handler`, calls the core's `handle` in process, with no socket), with
// none of the adapter's checks, so a test can send what the adapter never would (a bad id, an old
// version, a reused request id). The real adapter drives this example in collie's own test,
// bridge/mux/durable/example.test.ts.

import { randomUUID } from "node:crypto";
import { request } from "node:http";
import type { Ask, ConversationItemsReply, ConversationsReply, EventsReply, Hello, Problem, Snapshot } from "../../../packages/durable-sdk/src/core/types.ts";

export interface Dial {
  /** The program's Unix socket. */
  socket?: string;
  /** Instead of a socket: the core's `handle`, called in this process. */
  handler?: (request: Request) => Promise<Response>;
  /** Sent as X-Collie-Session. Undefined sends none. */
  version?: number;
}

export interface Reply<T = any> {
  status: number;
  etag?: string;
  body: T & Partial<Problem>;
}

/** One request over the Unix socket. */
export function call<T = any>(d: Dial, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Reply<T>> {
  const headers: Record<string, string> = { ...extra };
  if (d.version !== undefined) headers["x-collie-session"] = String(d.version);
  const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  if (payload) headers["content-type"] = "application/json";
  if (d.handler) return callHandler(d.handler, method, path, headers, payload);
  return new Promise((ok, fail) => {
    const req = request({ socketPath: d.socket, method, path: `/session/v1${path}`, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        ok({ status: res.statusCode ?? 0, etag: res.headers.etag, body: text ? JSON.parse(text) : undefined });
      });
    });
    req.on("error", fail);
    if (payload) req.write(payload);
    req.end();
  });
}

async function callHandler<T>(handler: NonNullable<Dial["handler"]>, method: string, path: string, headers: Record<string, string>, payload?: string): Promise<Reply<T>> {
  const res = await handler(new Request(`http://localhost/session/v1${path}`, { method, headers, ...(payload ? { body: payload } : {}) }));
  const text = await res.text();
  return { status: res.status, etag: res.headers.get("etag") ?? undefined, body: text ? JSON.parse(text) : undefined };
}

const enc = encodeURIComponent;
const mint = () => randomUUID();

/** The pane as the snapshot shows it now: its `turnId` and each ask's `revision` come from here. */
async function paneNow(d: Dial, id: string) {
  return (await api.snapshot(d)).body.panes?.find((p) => p.id === id);
}

export const api = {
  hello: (d: Dial) => call<Hello>(d, "GET", "/hello"),
  snapshot: (d: Dial, etag?: string) => call<Snapshot>(d, "GET", "/snapshot", undefined, etag ? { "if-none-match": etag } : {}),
  /** `epoch` left out: the current one, from `hello`. A real reader sends the epoch its cursor came from. */
  events: async (d: Dial, pane: string, after: number, epoch?: string) =>
    call<EventsReply>(d, "GET", `/pane/${enc(pane)}/events?after=${after}&epoch=${enc(epoch ?? (await api.hello(d)).body.epoch)}`),
  /** `revision` left out: the one the snapshot shows for that ask (1 when the ask is not open). */
  answer: async (d: Dial, pane: string, askId: string, optionId: string, o: { revision?: number; requestId?: string; note?: string } = {}) => {
    const revision = o.revision ?? (await paneNow(d, pane))?.openAsks.find((a) => a.id === askId)?.revision ?? 1;
    const answer = { optionId, ...(o.note === undefined ? {} : { note: o.note }) };
    return call(d, "POST", `/pane/${enc(pane)}/answer`, { requestId: o.requestId ?? mint(), askId, revision, answer });
  },
  /** An answer of any shape (WIRE.md 7.14): `{ optionIds }`, `{ text }` or `{ values }`. `revision` as for `answer`. */
  answerWith: async (d: Dial, pane: string, askId: string, answer: object, o: { revision?: number; requestId?: string } = {}) => {
    const revision = o.revision ?? (await paneNow(d, pane))?.openAsks.find((a) => a.id === askId)?.revision ?? 1;
    return call(d, "POST", `/pane/${enc(pane)}/answer`, { requestId: o.requestId ?? mint(), askId, revision, answer });
  },
  /** Neither `turnId` nor `askId` given: the pane's current `turnId`, from the snapshot. */
  send: async (d: Dial, pane: string, text: string, o: { steer?: boolean; turnId?: string; askId?: string; requestId?: string } = {}) => {
    const target = o.turnId || o.askId ? { turnId: o.turnId, askId: o.askId } : { turnId: (await paneNow(d, pane))?.turnId };
    return call(d, "POST", `/pane/${enc(pane)}/send`, { requestId: o.requestId ?? mint(), text, steer: o.steer ?? false, ...target });
  },
  abort: async (d: Dial, pane: string, o: { turnId?: string; askId?: string; requestId?: string } = {}) => {
    const target = o.turnId || o.askId ? { turnId: o.turnId, askId: o.askId } : { turnId: (await paneNow(d, pane))?.turnId };
    return call(d, "POST", `/pane/${enc(pane)}/abort`, { requestId: o.requestId ?? mint(), ...target });
  },
  rename: (d: Dial, kind: string, id: string, title: unknown, requestId: string = mint()) => call(d, "POST", "/rename", { requestId, kind, id, title }),
  action: (d: Dial, pane: string, actionId: string, o: { turnId?: string; requestId?: string } = {}) =>
    call(d, "POST", `/pane/${enc(pane)}/action`, { requestId: o.requestId ?? mint(), actionId, ...(o.turnId === undefined ? {} : { turnId: o.turnId }) }),
  close: (d: Dial, kind: string, id: string, requestId: string = mint()) => call(d, "POST", "/close", { requestId, kind, id }),
  start: (d: Dial, starter: string, requestId: string = mint()) => call(d, "POST", `/starter/${enc(starter)}`, { requestId }),
  /** `GET /conversations` (WIRE.md 7.16). */
  conversations: (d: Dial, o: { after?: string; limit?: number | string } = {}) =>
    call<ConversationsReply>(d, "GET", `/conversations${query(o)}`),
  /** `GET /conversation/:id/items` (WIRE.md 7.16). */
  items: (d: Dial, id: string, o: { after?: string; limit?: number | string } = {}) =>
    call<ConversationItemsReply>(d, "GET", `/conversation/${enc(id)}/items${query(o)}`),
  reopen: (d: Dial, id: string, requestId: string = mint()) => call(d, "POST", "/reopen", { requestId, id }),
};

/** `?after=..&limit=..` with the parts that are set, or "". */
function query(o: { after?: string; limit?: number | string }): string {
  const parts = [o.after === undefined ? "" : `after=${enc(o.after)}`, o.limit === undefined ? "" : `limit=${enc(String(o.limit))}`].filter(Boolean);
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

/** The oldest open ask of a pane. The wire lists them oldest first. */
export async function oldestAsk(d: Dial, pane: string): Promise<Ask | undefined> {
  return (await api.snapshot(d)).body.panes?.find((p) => p.id === pane)?.openAsks[0];
}

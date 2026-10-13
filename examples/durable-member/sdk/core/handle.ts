// The durable wire, version 1, as one function: a web `Request` in, a `Response` out. No socket, no runtime
// import. The Bun server (../server.ts) and a Cloudflare Worker both call it.
// Check order: version (409 incompatible), then hello, then ready (503 starting), then the route (404).
// A server that can tell who calls (the Bun server's descendant check) passes `refuseAct`. It runs before the
// four acts (answer, send, abort, starter) and throws 403 `caller-refused`. Reads never call it.

import { BadAnswer, type Pane, type Store } from "./layout.ts";
import { digestOf, HttpError, STARTER_GROUP } from "./receipts.ts";
import { assertId, bytes, CAPS, cut, idOk } from "./rules.ts";
import {
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

/** What `handle` reads and changes. One per program. */
export interface CoreState {
  store: Store;
  hostName: string;
  caps: Caps;
}

/** Per request, from the server that accepted it. */
export interface CallInfo {
  /** Throws an `HttpError` (403 `caller-refused`) when this caller may read but not act. */
  refuseAct?: () => void;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A body is one JSON object. Over 64 KiB is 413: the rest is read and dropped so the client sees the answer. */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Uint8Array[] = [];
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size <= CAPS.body) chunks.push(value);
    }
  }
  if (size > CAPS.body) throw new HttpError(413, "too-large");
  if (size === 0) return {};
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(all));
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

/** A proxy that compresses a reply (Cloudflare does) turns a strong ETag weak. The compare ignores the `W/`. */
const sameTag = (header: string | null, etag: string) => header !== null && header.trim().replace(/^W\//, "") === etag;

export function hello(state: CoreState): Hello {
  return {
    service: "collie-durable",
    protocol: { ...PROTOCOL_RANGE },
    host: { name: cut(state.hostName, CAPS.hostName) },
    epoch: state.store.epoch,
    ready: state.store.ready,
    caps: state.caps,
  };
}

/** Serve one request of the wire. Never throws: a named error becomes its `Problem`, anything else a 500 `internal`. */
export async function handle(request: Request, state: CoreState, call: CallInfo = {}): Promise<Response> {
  try {
    return await route(request, state, call);
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { code: e.code, ...e.extra });
    console.error("session server error:", e);
    return json(500, { code: "internal" });
  }
}

async function route(request: Request, state: CoreState, call: CallInfo): Promise<Response> {
  const { store, caps } = state;
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean); // session v1 ...
  if (parts[0] !== "session" || parts[1] !== "v1") return json(404, { code: "not-found" });
  const route = parts.slice(2);

  // 1. Version. `hello` may come without a header (that is how a caller finds the range). Nothing else may.
  const header = request.headers.get("x-collie-session");
  const version = header === null ? undefined : /^\d+$/.test(header) ? Number(header) : Number.NaN;
  const inRange = version !== undefined && version >= PROTOCOL_RANGE.min && version <= PROTOCOL_RANGE.max;
  const isHello = route[0] === "hello" && route.length === 1;
  if (!(inRange || (isHello && version === undefined))) {
    return json(409, { code: "incompatible", range: { ...PROTOCOL_RANGE } });
  }

  const method = request.method;
  // 2. hello
  if (method === "GET" && isHello) return json(200, hello(state));
  // 3. ready
  if (!store.ready) return json(503, { code: "starting" });

  // 4. the route
  if (method === "GET" && route[0] === "snapshot" && route.length === 1) {
    const snap = store.snapshot();
    const etag = `"${snap.epoch}-${snap.rev}"`;
    if (sameTag(request.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers: { etag } });
    return json(200, snap, { etag });
  }

  if (route[0] === "pane" && route.length === 3) {
    const verb = route[2];
    const want = verb === "events" ? "GET" : verb === "answer" || verb === "send" || verb === "abort" ? "POST" : undefined;
    if (method !== want) return json(404, { code: "not-found" });
    const id = decode(route[1]!);
    const pane = id === undefined ? undefined : store.panes.get(id);
    if (!pane) return json(404, { code: "no-such-pane" });

    if (verb === "events") {
      const afterText = url.searchParams.get("after");
      const epoch = url.searchParams.get("epoch");
      if (afterText === null || !/^\d+$/.test(afterText) || !Number.isSafeInteger(Number(afterText))) throw new HttpError(400, "bad-cursor");
      if (!epoch) throw new HttpError(400, "bad-cursor"); // a cursor means nothing without the epoch it came from
      const reply: EventsReply = { epoch: store.epoch, ...pane.eventsAfter(Number(afterText), epoch !== store.epoch) };
      return json(200, reply);
    }

    call.refuseAct?.();
    const body = await readBody(request);
    const requestId = idField(body, "requestId");
    // The receipt is bound to the payload: the same id with another pane, ask, revision, option, note, turn or text is 409.
    const once = <T extends object>(payload: object, act: () => Promise<T>) => store.receipts.run(requestId, digestOf({ verb, pane: pane.id, ...payload }), act, pane.id);

    if (verb === "answer") {
      const askId = idField(body, "askId");
      const { revision, answer } = body as Partial<AnswerRequest>;
      if (!Number.isSafeInteger(revision) || (revision as number) < 0) throw badBody("revision must be a non-negative integer");
      if (typeof answer !== "object" || answer === null || Array.isArray(answer)) throw badBody("answer must be an object");
      const optionId = idField(answer as unknown as Record<string, unknown>, "optionId");
      const note = (answer as { note?: unknown }).note;
      if (note !== undefined && note !== null && (typeof note !== "string" || bytes(note) > CAPS.note)) throw badBody("note must be a string of at most 2048 bytes");
      return json(
        200,
        await once<AnswerReply>({ askId, revision, optionId, note: typeof note === "string" ? note : null }, async () => {
          const open = pane.asks.get(askId);
          if (!open) return { result: "too-late" }; // answered or stopped (a re-raised ask keeps its id across a restart)
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
    if (!starter) return json(404, { code: "no-such-starter" });
    call.refuseAct?.();
    const body = await readBody(request);
    const requestId = idField(body, "requestId");
    if (!caps.starters) throw new HttpError(409, "not-supported");
    return json(
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
      }, STARTER_GROUP),
    );
  }

  return json(404, { code: "not-found" });
}

// The durable wire, version 1, as one function: a web `Request` in, a `Response` out. No socket, no runtime
// import. The Bun server (../server.ts) and a Cloudflare Worker both call it.
// Check order: version (409 incompatible), then hello, then ready (503 starting), then the route (404).
// A server that can tell who calls (the Bun server's descendant check) passes `refuseAct`. It runs before every
// act (answer, send, abort, action, rename, close, reopen and starter) and throws 403 `caller-refused`. Reads never
// call it.

import { AnswerDecided, BadAnswer, cleanConversationRow, cleanItem, type Pane, type Store } from "./layout.ts";
import { CLOSE_GROUP, digestOf, HttpError, RENAME_GROUP, REOPEN_GROUP, STARTER_GROUP } from "./receipts.ts";
import {
  ANSWER_TEXT_BYTES,
  assertId,
  bytes,
  CAPS,
  cursorOk,
  cut,
  idOk,
  isFlag,
  isList,
  isRecord,
  isSafeInteger,
  isText,
  LIMITS,
  renameTitleOf,
} from "./rules.ts";
import {
  type Answer,
  type ActionContext,
  type AnswerReply,
  type Caps,
  type ControlReply,
  type ConversationItemsReply,
  type ConversationsReply,
  type EventsReply,
  type FormAnswer,
  type Hello,
  type Item,
  type Json,
  type JsonObject,
  type Problem,
  PROTOCOL_RANGE,
  type ProgramHooks,
  type ReopenTarget,
  type Snapshot,
  type StarterReply,
  type VersionRefusal,
} from "./types.ts";

/** What `handle` reads and changes. One per program. */
export interface CoreState {
  store: Store;
  hostName: string;
  caps: Caps;
  /**
   * The program's hooks. `onRename` is asked before a workspace or a tab takes a new title (WIRE.md 7.8): `false`
   * refuses it (422 `rename-refused`, nothing changes, the same request id may try again). Absent: every rename the
   * wire accepts is applied. `onSend` and `onAbort` are the pane's fallback, see `PaneHandle.onSend`.
   */
  hooks: ProgramHooks;
  /** Where the core writes its one-line notes, for example a Collie that speaks another wire version. */
  warn?: (line: string) => void;
  /** The Collie versions a refusal was already written for, so each is named once. */
  warned?: Set<number>;
}

/** Per request, from the server that accepted it. */
export interface CallInfo {
  /** Throws an `HttpError` (403 `caller-refused`) when this caller may read but not act. */
  refuseAct?: () => void;
}

/** Every body the wire answers with (WIRE.md section 4). */
type ReplyBody = Hello | Snapshot | EventsReply | Problem | AnswerReply | ControlReply | StarterReply | ConversationsReply | ConversationItemsReply;

const json = (status: number, body: ReplyBody, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A body is one JSON object. Over 64 KiB is 413: the rest is read and dropped so the client sees the answer. */
async function readBody(request: Request): Promise<JsonObject> {
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
  let body: Json;
  try {
    body = JSON.parse(new TextDecoder().decode(all));
  } catch {
    throw new HttpError(400, "bad-json");
  }
  if (!isRecord(body)) throw new HttpError(400, "bad-body", { message: "the body is one JSON object" });
  return body;
}

const badBody = (why: string) => new HttpError(400, "bad-body", { message: cut(why, CAPS.message) });

/** A field that is present, a string, and follows the id rule. Missing or not a string: bad-body. Breaks the rule: bad-id. */
function idField(body: JsonObject, name: string): string {
  const v = body[name];
  if (!isText(v)) throw badBody(`${name} must be a string`);
  if (!idOk(v)) throw new HttpError(400, "bad-id", { message: `${name} breaks the id rule` });
  return v;
}

/**
 * The `answer` member of an answer request, read for its shape (WIRE.md 7.14): exactly one of `optionId` (with an
 * optional `note`), `optionIds`, `text` or `values`. A wrong type or an over-cap string is 400 `bad-body`, an id that
 * breaks the id rule 400 `bad-id`. Whether the shape fits THIS ask is the pane's to say, once the ask is known to be open.
 */
function answerOf(raw: Json | undefined): Answer {
  if (!isRecord(raw)) throw badBody("answer must be an object");
  const answer = raw;
  const named = ["optionId", "optionIds", "text", "values"].filter((key) => answer[key] !== undefined);
  if (named.length !== 1) throw badBody("answer names exactly one of optionId, optionIds, text and values");
  if (named[0] === "optionId") {
    const optionId = idField(answer, "optionId");
    const note = answer.note;
    if (note !== undefined && note !== null && (!isText(note) || bytes(note) > CAPS.note)) throw badBody("note must be a string of at most 2048 bytes");
    return isText(note) ? { optionId, note } : { optionId };
  }
  if (answer.note !== undefined && answer.note !== null) throw badBody("only an optionId answer has a note");
  if (named[0] === "optionIds") {
    const ids = answer.optionIds;
    if (!isList(ids) || ids.length < 1 || ids.length > LIMITS.choiceOptions) throw badBody(`optionIds is a list of 1 to ${LIMITS.choiceOptions} ids`);
    const optionIds: string[] = [];
    for (const id of ids) {
      if (!isText(id)) throw badBody("optionIds are strings");
      if (!idOk(id)) throw new HttpError(400, "bad-id", { message: "an id in optionIds breaks the id rule" });
      optionIds.push(id);
    }
    return { optionIds };
  }
  if (named[0] === "text") {
    const text = answer.text;
    if (!isText(text) || text === "" || bytes(text) > ANSWER_TEXT_BYTES) throw badBody(`text must be 1 to ${ANSWER_TEXT_BYTES} bytes`);
    return { text };
  }
  const values = answer.values;
  if (!isRecord(values)) throw badBody("values must be an object");
  const out: FormAnswer["values"] = {};
  const entries = Object.entries(values);
  if (entries.length < 1 || entries.length > LIMITS.formFields) throw badBody(`values holds 1 to ${LIMITS.formFields} fields`);
  for (const [key, value] of entries) {
    if (!idOk(key)) throw new HttpError(400, "bad-id", { message: "a field id in values breaks the id rule" });
    if (isFlag(value)) out[key] = value;
    else if (isText(value)) {
      if (bytes(value) > ANSWER_TEXT_BYTES) throw badBody(`a field value is at most ${ANSWER_TEXT_BYTES} bytes`);
      out[key] = value;
    } else if (isList(value) && value.length <= LIMITS.choiceOptions && value.every(isText)) {
      for (const id of value) if (!idOk(id)) throw new HttpError(400, "bad-id", { message: "an id in values breaks the id rule" });
      out[key] = [...value];
    } else throw badBody("a field value is a string, a list of ids or a boolean");
  }
  return { values: out };
}

/** A form answer as a list of `[field id, value]` pairs, keys sorted. */
type CanonicalForm = {
  values: [string, FormAnswer["values"][string]][];
};

/** The answer as a stable value for the receipt's digest: keys sorted, so the same form is the same payload. */
function canonical(answer: Answer): Exclude<Answer, FormAnswer> | CanonicalForm {
  if ("values" in answer) return { values: Object.keys(answer.values).toSorted().map((key) => [key, answer.values[key]]) };
  return answer;
}

/** Exactly one of `turnId` and `askId`. */
function targetOf(body: JsonObject): { turnId: string } | { askId: string } {
  const hasTurn = body.turnId !== undefined && body.turnId !== null;
  const hasAsk = body.askId !== undefined && body.askId !== null;
  if (hasTurn === hasAsk) throw badBody("exactly one of turnId and askId");
  return hasTurn ? { turnId: idField(body, "turnId") } : { askId: idField(body, "askId") };
}

/** 409 `stale` with the pane's current turn and open ask ids. */
function stale(pane: Pane, extra: Pick<Problem, "ask"> = {}): HttpError {
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

/**
 * The paging of a history route (WIRE.md 7.16): `after` is the cursor the last page named, or absent for the first
 * page; `limit` a whole number from 1, cut to `max`, and `max` when absent. Anything else is 400 `bad-cursor`.
 */
/** One page request of a history route. */
interface PageRequest {
  after: string | undefined;
  limit: number;
}

function pageOf(url: URL, max: number): PageRequest {
  const after = url.searchParams.get("after");
  const limitText = url.searchParams.get("limit");
  if (after !== null && !cursorOk(after)) throw new HttpError(400, "bad-cursor");
  if (limitText !== null && (!/^\d+$/.test(limitText) || Number(limitText) < 1 || !Number.isSafeInteger(Number(limitText)))) throw new HttpError(400, "bad-cursor");
  return { after: after ?? undefined, limit: limitText === null ? max : Math.min(Number(limitText), max) };
}

/** A cursor the program's provider handed back: a printable string the wire can carry, else a bug in the program. */
function nextOf(next: string | undefined): string | undefined {
  if (next === undefined) return undefined;
  if (!cursorOk(next)) throw new TypeError(`a history cursor is 1 to ${CAPS.historyCursor} bytes of printable ASCII: ${JSON.stringify(next)}`);
  return next;
}

/** How many of `items` fit in one reply, inside the reply budget. At least one: a cleaned item is far below it. */
function fitting(items: readonly Item[]): number {
  let size = 0;
  for (let i = 0; i < items.length; i++) {
    size += bytes(JSON.stringify(items[i]));
    if (i > 0 && size > LIMITS.replyBytes) return i;
  }
  return items.length;
}

/** A proxy that compresses a reply (Cloudflare does) turns a strong ETag weak. The compare ignores the `W/`. */
const sameTag = (header: string | null, etag: string) => header !== null && header.trim().replace(/^W\//, "") === etag;

/**
 * The refusal a 409 `incompatible` carries when the caller named a version (WIRE.md section 2): the version Collie sent
 * and this program's range. A Collie that speaks none of this program's versions sends one `hello` with its own version
 * per start of the program, so the program can name the mismatch: the core writes it once per version, in one line.
 */
function versionRefusal(state: CoreState, version: number | undefined): Pick<Problem, "refusal"> {
  if (version === undefined || !Number.isSafeInteger(version)) return {};
  const refusal: VersionRefusal = { code: "version", collie: [version, version], program: [PROTOCOL_RANGE.min, PROTOCOL_RANGE.max] };
  const warned = (state.warned ??= new Set());
  if (!warned.has(version)) {
    warned.add(version);
    (state.warn ?? ((line: string) => console.warn(line)))(`collie: ${versionLine(refusal)}`);
  }
  return { refusal };
}

/** The line a program writes for a refusal: Collie's version first, then the program's own, as Collie's notice row words it. */
export function versionLine(refusal: VersionRefusal): string {
  return `Collie speaks wire v${refusal.collie[1]}, this durable agent speaks v${refusal.program[1]}. Update the agent's SDK, or Collie.`;
}

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
    return await dispatch(request, state, call);
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { code: e.code, ...e.extra });
    console.error("session server error:", e);
    return json(500, { code: "internal" });
  }
}

async function dispatch(request: Request, state: CoreState, call: CallInfo): Promise<Response> {
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
    return json(409, { code: "incompatible", range: { ...PROTOCOL_RANGE }, ...versionRefusal(state, version) });
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
    const want = verb === "events" ? "GET" : verb === "answer" || verb === "send" || verb === "abort" || verb === "action" ? "POST" : undefined;
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
    const once = <T extends object>(payload: JsonObject, act: () => Promise<T>) => store.receipts.run(requestId, digestOf({ verb, pane: pane.id, ...payload }), act, pane.id);

    if (verb === "answer") {
      const askId = idField(body, "askId");
      const revision = body.revision;
      if (!isSafeInteger(revision) || revision < 0) throw badBody("revision must be a non-negative integer");
      const answer = answerOf(body.answer);
      // The digest of a permission answer is what it always was: the option and the note. The other shapes add theirs.
      const bound = "optionId" in answer ? { optionId: answer.optionId, note: answer.note ?? null } : { answer: canonical(answer) };
      return json(
        200,
        await once<AnswerReply>({ askId, revision, ...bound }, async () => {
          // An ask past its `expiresAt` is decided by `timeout` before this answer is read (WIRE.md 7.3).
          pane.sweep();
          const open = pane.asks.get(askId);
          if (!open) {
            // Decided already, by the phone, the program or the clock: the first outcome stands, and the phone shows it.
            const outcome = pane.outcomeOf(askId);
            if (outcome !== undefined) throw new HttpError(409, "decided", { outcome });
            return { result: "too-late" }; // unknown here: from before a restart, or past what the pane remembers
          }
          if (open.ask.revision !== revision) throw stale(pane, { ask: open.ask });
          try {
            return { result: await pane.answer(askId, answer, requestId) };
          } catch (e) {
            // A host with no process of its own: another instance decided the ask first.
            if (e instanceof AnswerDecided) throw new HttpError(409, "decided", { outcome: e.outcome });
            if (e instanceof BadAnswer) throw new HttpError(400, e.code);
            throw e;
          }
        }),
      );
    }

    if (verb === "send") {
      const target = targetOf(body);
      const { text, steer } = body;
      if (!isText(text) || text === "" || bytes(text) > CAPS.sendText) throw badBody("text must be 1 to 32768 bytes");
      if (steer !== undefined && steer !== null && !isFlag(steer)) throw badBody("steer must be a boolean");
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

    if (verb === "action") {
      const actionId = idField(body, "actionId");
      // `turnId` is optional here: a button belongs to the pane, and a program may not care which turn the phone saw.
      const turnId = body.turnId === undefined || body.turnId === null ? undefined : idField(body, "turnId");
      return json(
        200,
        await once<ControlReply>({ actionId, turnId: turnId ?? null }, async () => {
          if (!caps.actions || !pane.canAct) throw new HttpError(409, "not-supported");
          if (turnId !== undefined && turnId !== pane.turnId) throw stale(pane); // the turn can move between the adapter's check and this one
          const row = pane.actionRows.find((a) => a.id === actionId);
          if (!row) throw new HttpError(404, "no-such-action");
          // A dimmed button takes no tap, and a request for one is the program's refusal, not an act.
          if (row.disabled === true || row.busy === true) throw new HttpError(422, "action-refused", { message: "The action is not available now." });
          const turn: Pick<ActionContext, "turnId"> = {};
          if (turnId !== undefined) turn.turnId = turnId;
          const accepted = await pane.act({ actionId, ...turn, requestId });
          if (!accepted) throw new HttpError(422, "action-refused");
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

  if (method === "POST" && route[0] === "rename" && route.length === 1) {
    call.refuseAct?.();
    const body = await readBody(request);
    const requestId = idField(body, "requestId");
    const { kind } = body;
    if (kind !== "workspace" && kind !== "tab") throw badBody("kind must be workspace or tab");
    const id = idField(body, "id");
    const title = renameTitleOf(body.title);
    if (title === undefined) throw badBody("title must be 1 to 120 characters, with no control character");
    if (!caps.rename) throw new HttpError(409, "not-supported");
    return json(
      200,
      await store.receipts.run<ControlReply>(requestId, digestOf({ verb: "rename", kind, id, title }), async () => {
        const exists = kind === "workspace" ? store.workspaces.has(id) : store.tabs.has(id);
        if (!exists) throw new HttpError(404, "no-such-target");
        if (state.hooks.onRename && !(await state.hooks.onRename({ kind, id, title }, requestId))) throw new HttpError(422, "rename-refused");
        // The target can go while the hook runs. Then there is nothing to rename and nothing was changed.
        if (!store.rename(kind, id, title)) throw new HttpError(404, "no-such-target");
        return { ok: true };
      }, RENAME_GROUP),
    );
  }

  if (method === "POST" && route[0] === "close" && route.length === 1) {
    call.refuseAct?.();
    const body = await readBody(request);
    const requestId = idField(body, "requestId");
    const { kind } = body;
    if (kind !== "pane" && kind !== "tab" && kind !== "workspace") throw badBody("kind must be pane, tab or workspace");
    const id = idField(body, "id");
    if (!caps.close) throw new HttpError(409, "not-supported");
    return json(
      200,
      await store.receipts.run<ControlReply>(requestId, digestOf({ verb: "close", kind, id }), async () => {
        const target = store.closeTarget(kind, id);
        if (!target) throw new HttpError(404, "no-such-target");
        // Only `false` refuses: a hook that persists the close and returns nothing accepts it.
        if ((await state.hooks.onClose?.(target, requestId)) === false) throw new HttpError(422, "close-refused");
        // The target can go while the hook runs. Then there is nothing to close and nothing was changed.
        if (!store.close(kind, id)) throw new HttpError(404, "no-such-target");
        return { ok: true };
      }, CLOSE_GROUP),
    );
  }

  // History (WIRE.md 7.16): the program's own record of its conversations, open and closed. Reads: no descendant
  // check, no receipt. Without a provider the cap is false and both routes are 409 `not-supported`.
  if (method === "GET" && route[0] === "conversations" && route.length === 1) {
    const history = store.history;
    if (!caps.history || history === undefined) throw new HttpError(409, "not-supported");
    const { after, limit } = pageOf(url, LIMITS.conversationsPerPage);
    const page = await history.list(after, limit);
    const reply: ConversationsReply = { items: page.items.slice(0, limit).map(cleanConversationRow) };
    const next = nextOf(page.next);
    if (next !== undefined) reply.next = next;
    return json(200, reply);
  }

  if (method === "GET" && route[0] === "conversation" && route.length === 3 && route[2] === "items") {
    const history = store.history;
    if (!caps.history || history === undefined) throw new HttpError(409, "not-supported");
    const id = decode(route[1]!);
    if (id === undefined || !idOk(id)) return json(404, { code: "no-such-conversation" });
    const { after, limit } = pageOf(url, LIMITS.historyItems);
    let page = await history.items(id, after, limit);
    if (page === undefined) return json(404, { code: "no-such-conversation" });
    let items = page.items.slice(0, limit).map(cleanItem);
    // Over the reply budget: ask the provider again for the items that fit, so its own cursor names where to go on.
    const fit = fitting(items);
    if (fit < items.length) {
      page = await history.items(id, after, fit);
      if (page === undefined) return json(404, { code: "no-such-conversation" });
      items = page.items.slice(0, fit).map(cleanItem);
    }
    const next = nextOf(page.next);
    const reply: ConversationItemsReply = { items, more: next !== undefined };
    if (next !== undefined) reply.next = next;
    return json(200, reply);
  }

  if (method === "POST" && route[0] === "reopen" && route.length === 1) {
    call.refuseAct?.();
    const body = await readBody(request);
    const requestId = idField(body, "requestId");
    const id = idField(body, "id");
    if (!caps.reopen) throw new HttpError(409, "not-supported");
    return json(
      200,
      await store.receipts.run<ControlReply>(requestId, digestOf({ verb: "reopen", id }), async () => {
        const where = store.paneOfConversation(id);
        // Open already: there is nothing to put back.
        if (where?.open === true) return { ok: true };
        const known = where !== undefined || (store.history !== undefined && (await store.history.items(id, undefined, 1)) !== undefined);
        if (!known) throw new HttpError(404, "no-such-target");
        const target: ReopenTarget = { id };
        if (where !== undefined) target.paneId = where.paneId;
        // Only `false` refuses: a hook that shows the conversation again and returns nothing accepts it.
        if ((await state.hooks.onReopen?.(target, requestId)) === false) throw new HttpError(422, "reopen-refused");
        // The SDK's own default: put back the pane it closed in this process, when the hook did not show one.
        if (store.paneOfConversation(id)?.open !== true) store.reopen(id);
        if (store.paneOfConversation(id)?.open !== true) throw new HttpError(422, "reopen-refused", { message: "The durable agent did not show the conversation again." });
        return { ok: true };
      }, REOPEN_GROUP),
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

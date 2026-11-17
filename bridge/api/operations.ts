// THE OPERATION TABLE (M105 spec 03, decisions 15 and 17). One table, the single source of what the
// local API can do: the socket admits a request only through it, `hello` lists from it, and the command
// face (`collie api <operation>`, a later part) is generated from {@link DECLARED}. No operation exists
// outside this file.
//
// Each row names its kind (`read`, the only kind in this step), the RIGHT it needs, whether it may
// wait, how it parses its arguments, and its handler. A request is ADMITTED only when the table has a
// row of that name AND the caller was granted the row's right; everything else is refused, so the
// table DENIES BY DEFAULT: an unknown name is `api.unknown_op`, a row whose right was not granted is
// `api.denied`, and admission happens before a single argument is read. operations.test.ts walks every
// row, and plants a row with a right the local tier does not grant to see it refused.
//
// RIGHTS. `look` reads, `send` would type into a session, `control` would change one. The local tier
// grants `look` ONLY ({@link LOCAL_TIER_RIGHTS}); no row in this step needs more, and a later right
// needs its own spec, security read and Altan's word.
//
// THE SEVEN NAMES. `hello` and `events` are answered here. The other five (`sessions`, `brief`, `read`,
// `accounts`, `hill.list`) are declared here, arguments included, and their handlers come in through
// {@link TableDeps.reads}: a row whose handler this bridge was not given is not in its table at all, so
// it is neither offered by `hello` nor callable (`api.unknown_op`). Nothing here reaches a write path:
// the context a handler gets carries no way to type, answer an ask, or change a session.

import type { ApiErrorDetail, ErrorCode } from "../error-codes.ts";
import type { EventBus } from "../events/bus.ts";
import { SESSION_ID_MAX } from "../events/session-id.ts";
import type { JsonObject } from "../json.ts";
import { asJsonNumber, asJsonString } from "../../web/src/lib/json.ts";
import { wireEvent } from "./event-wire.ts";
import { CURSOR_MAX, WAIT_MAX_SECONDS, WAITS_PER_CONNECTION, WAITS_TOTAL } from "./limits.ts";

/** What a caller may be granted. */
export type Right = "look" | "send" | "control";

/** The rights of a caller of the local socket: read only, in this step (decision 15). */
export const LOCAL_TIER_RIGHTS: readonly Right[] = ["look"];

/** The version of the API's wire, in `hello`. */
export const API_VERSION = 1;

/** Every operation name, in the order `hello` lists them. */
export const OPERATION_NAMES = ["hello", "sessions", "brief", "read", "accounts", "hill.list", "events"] as const;
export type OperationName = (typeof OPERATION_NAMES)[number];

/** A row's arguments, read, or why they could not be. `reason` is a fixed phrase of this file, never the caller's text. */
export type Parsed<A> = { readonly ok: true; readonly args: A } | { readonly ok: false; readonly reason: string };

/** What a handler answers: the fields of the answer line, or a refusal by code. */
export type OpResult = { readonly ok: true; readonly answer: JsonObject } | { readonly ok: false; readonly code: ErrorCode; readonly detail?: ApiErrorDetail };

/** What a handler gets of the connection it answers. No write path is reachable from here. */
export interface OperationContext {
  /** Aborts when the connection closes or the socket stops. */
  readonly signal: AbortSignal;
  /** The operations this caller may call, in table order. */
  readonly offered: readonly string[];
  /** Whether the socket still stands: the started server, its file in place with the same inode. */
  standing(): boolean;
  /** Take one wait slot; null when the connection or the whole socket holds the most already. A row that does not wait gets null. */
  claimWait(): (() => void) | null;
}

/** One row, typed by its arguments. */
export interface OperationRow<A> {
  readonly name: string;
  readonly kind: "read";
  readonly right: Right;
  /** Whether the operation may hold the request open (an `events` wait). Only such a row gets wait slots. */
  readonly waits: boolean;
  /** One line for the command face and its help. */
  readonly summary: string;
  parse(input: JsonObject): Parsed<A>;
  handle(args: A, ctx: OperationContext): Promise<OpResult>;
}

/** A row as the table holds it, its argument type closed inside `run`. */
export interface TableRow {
  readonly name: string;
  readonly kind: "read";
  readonly right: Right;
  readonly waits: boolean;
  readonly summary: string;
  /** Parse, then handle. A parse failure answers `api.bad_request`. */
  run(input: JsonObject, ctx: OperationContext): Promise<OpResult>;
}

/** The table: its rows by name, in table order. */
export type OperationTable = ReadonlyMap<string, TableRow>;

/** Close a typed row into a table row. */
export function row<A>(def: OperationRow<A>): TableRow {
  return {
    name: def.name,
    kind: def.kind,
    right: def.right,
    waits: def.waits,
    summary: def.summary,
    run: async (input, ctx) => {
      const parsed = def.parse(input);
      if (!parsed.ok) return { ok: false, code: "api.bad_request", detail: { reason: parsed.reason } };
      return def.handle(parsed.args, ctx);
    },
  };
}

/** A table of these rows. Throws on a repeated name: that is a bug of the caller. */
export function tableOf(rows: readonly TableRow[]): OperationTable {
  const table = new Map<string, TableRow>();
  for (const one of rows) {
    if (table.has(one.name)) throw new TypeError(`api: the operation ${one.name} is in the table twice`);
    table.set(one.name, one);
  }
  return table;
}

export type Admission = { readonly ok: true; readonly row: TableRow } | { readonly ok: false; readonly code: "api.unknown_op" | "api.denied" };

/** Admit a request by its operation name and the caller's rights. Denies by default. */
export function admit(table: OperationTable, op: string, granted: ReadonlySet<Right>): Admission {
  const found = table.get(op);
  if (found === undefined) return { ok: false, code: "api.unknown_op" };
  if (!granted.has(found.right)) return { ok: false, code: "api.denied" };
  return { ok: true, row: found };
}

/** The names a caller with these rights may call, in table order. */
export function offeredOf(table: OperationTable, granted: ReadonlySet<Right>): string[] {
  return [...table.values()].filter((one) => granted.has(one.right)).map((one) => one.name);
}

// ── The arguments ────────────────────────────────────────────────────────────────────────────────

/** No arguments. */
export type NoArgs = Readonly<Record<string, never>>;

/** One session, by its opaque id (ids.ts resolves it). */
export interface SessionArgs {
  readonly session: string;
}

export interface EventsArgs {
  /** The cursor to resume after; absent: start at now. */
  readonly after: string | undefined;
  /** How long to wait for an event when there is none, in whole seconds. */
  readonly wait: number;
}

/** The argument type of each operation. */
export interface ArgsOf {
  hello: NoArgs;
  sessions: NoArgs;
  brief: SessionArgs;
  read: SessionArgs;
  accounts: NoArgs;
  "hill.list": NoArgs;
  events: EventsArgs;
}

function onlyKeys(input: JsonObject, allowed: readonly string[]): boolean {
  return Object.keys(input).every((key) => allowed.includes(key));
}

function parseNone(input: JsonObject): Parsed<NoArgs> {
  if (!onlyKeys(input, [])) return { ok: false, reason: "this operation takes no arguments" };
  return { ok: true, args: {} };
}

function parseSession(input: JsonObject): Parsed<SessionArgs> {
  if (!onlyKeys(input, ["session"])) return { ok: false, reason: "an argument this operation does not take" };
  const session = asJsonString(input.session);
  if (session === undefined || session === "") return { ok: false, reason: "args.session must be a session id from sessions" };
  if (session.length > SESSION_ID_MAX) return { ok: false, reason: "args.session is too long to be a session id" };
  return { ok: true, args: { session } };
}

function parseEvents(input: JsonObject): Parsed<EventsArgs> {
  if (!onlyKeys(input, ["after", "wait"])) return { ok: false, reason: "an argument this operation does not take" };
  let after: string | undefined;
  if (input.after !== undefined) {
    after = asJsonString(input.after);
    if (after === undefined || after === "" || after.length > CURSOR_MAX) return { ok: false, reason: "args.after must be a cursor from an earlier answer" };
  }
  let wait = 0;
  if (input.wait !== undefined) {
    const seconds = asJsonNumber(input.wait);
    if (seconds === undefined || !Number.isInteger(seconds) || seconds < 0 || seconds > WAIT_MAX_SECONDS) {
      return { ok: false, reason: `args.wait must be a whole number of seconds from 0 to ${String(WAIT_MAX_SECONDS)}` };
    }
    wait = seconds;
  }
  return { ok: true, args: { after, wait } };
}

/** A row's declaration: everything but the handler. The command face reads these. */
export type Declaration<A> = Omit<OperationRow<A>, "handle">;

/** The declaration of each operation, typed by its arguments. */
export type Declarations = { readonly [K in OperationName]: Declaration<ArgsOf[K]> };

/** Every operation, declared. */
export const DECLARED: Declarations = {
  hello: { name: "hello", kind: "read", right: "look", waits: false, summary: "The API version, the Collie version and the operations offered.", parse: parseNone },
  sessions: { name: "sessions", kind: "read", right: "look", waits: false, summary: "The agent sessions of this machine.", parse: parseNone },
  brief: { name: "brief", kind: "read", right: "look", waits: false, summary: "The state of one session, with no text.", parse: parseSession },
  read: { name: "read", kind: "read", right: "look", waits: false, summary: "The screen of one session, secrets masked, capped.", parse: parseSession },
  accounts: { name: "accounts", kind: "read", right: "look", waits: false, summary: "The agent accounts of this machine.", parse: parseNone },
  "hill.list": { name: "hill.list", kind: "read", right: "look", waits: false, summary: "The open decisions on the Hill, with no body.", parse: parseNone },
  events: { name: "events", kind: "read", right: "look", waits: true, summary: "The events after a cursor, waiting up to 25 seconds for one.", parse: parseEvents },
};

/** A handler of each operation. */
export type Handlers = { readonly [K in OperationName]: (args: ArgsOf[K], ctx: OperationContext) => Promise<OpResult> };

/** The five read operations whose handlers come from outside this file. */
export type ReadName = "sessions" | "brief" | "read" | "accounts" | "hill.list";
export type ReadHandlers = Pick<Handlers, ReadName>;

export interface TableDeps {
  /** The Collie version, as the bridge reports it (bridge/version.ts). */
  readonly version: () => string;
  /** The event bus, read only. */
  readonly bus: Pick<EventBus, "since" | "waitFor">;
  /** The five read handlers. One left out is not offered on this bridge. */
  readonly reads?: Partial<ReadHandlers>;
}

function bind<K extends OperationName>(name: K, handler: Handlers[K] | undefined): TableRow | null {
  if (handler === undefined) return null;
  return row<ArgsOf[K]>({ ...DECLARED[name], handle: handler });
}

/** `hello` (decision 17): what this socket is and what the caller may call. */
function hello(deps: TableDeps): Handlers["hello"] {
  return async (_args, ctx) => ({ ok: true, answer: { api: API_VERSION, collie: deps.version(), experimental: true, operations: [...ctx.offered] } });
}

/**
 * `events` (decision 17): the events after `after`; with none and `wait` > 0, one wait on the bus for
 * the next, then the events again. The wait takes a slot (decision 18), ends early on the connection's
 * close or the socket's stop, and checks at its wake that the socket still stands.
 */
function events(deps: TableDeps): Handlers["events"] {
  return async (args, ctx) => {
    const first = deps.bus.since(args.after);
    if (first.events.length > 0 || args.wait === 0) return { ok: true, answer: { events: first.events.map(wireEvent), next: first.next } };
    const release = ctx.claimWait();
    if (release === null) return { ok: false, code: "api.too_many_waits", detail: { perConnection: WAITS_PER_CONNECTION, total: WAITS_TOTAL } };
    const from = args.after ?? first.next;
    let outcome: Awaited<ReturnType<EventBus["waitFor"]>>;
    try {
      outcome = await deps.bus.waitFor(from, args.wait * 1000, ctx.signal);
    } finally {
      release();
    }
    if (outcome === "aborted" || !ctx.standing()) return { ok: false, code: "api.closing" };
    const after = deps.bus.since(from);
    return { ok: true, answer: { events: after.events.map(wireEvent), next: after.next } };
  };
}

/** The table of this bridge: `hello`, `events`, and the read rows it was given handlers for. */
export function buildTable(deps: TableDeps): OperationTable {
  const handlers: Partial<Handlers> = { ...deps.reads, hello: hello(deps), events: events(deps) };
  const rows: TableRow[] = [];
  for (const name of OPERATION_NAMES) {
    const bound = bindByName(name, handlers);
    if (bound !== null) rows.push(bound);
  }
  return tableOf(rows);
}

function bindByName(name: OperationName, handlers: Partial<Handlers>): TableRow | null {
  switch (name) {
    case "hello":
      return bind(name, handlers.hello);
    case "sessions":
      return bind(name, handlers.sessions);
    case "brief":
      return bind(name, handlers.brief);
    case "read":
      return bind(name, handlers.read);
    case "accounts":
      return bind(name, handlers.accounts);
    case "hill.list":
      return bind(name, handlers["hill.list"]);
    case "events":
      return bind(name, handlers.events);
    default: {
      const never: never = name;
      throw new TypeError(`api: an unknown operation ${String(never)}`);
    }
  }
}

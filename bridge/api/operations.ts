// THE OPERATION TABLE (M105 spec 03, decisions 15 and 17). One table, the single source of what the
// local API can do: the socket admits a request only through it, `hello` lists from it, and the command
// face (`collie api <operation>`, cli/api.ts) is generated from {@link DECLARED}. No operation exists
// outside this file.
//
// Each row names its kind (`read`, the only kind in this step), the RIGHT it needs, whether it may
// wait, how it parses its arguments, and its handler. A request is ADMITTED only when the table has a
// row of that name AND the caller was granted the row's right; everything else is refused, so the
// table DENIES BY DEFAULT: an unknown name is `api.unknown_op`, a row whose right was not granted is
// `api.denied`, and admission happens before a single argument is read. operations.test.ts walks every
// row, and plants a row with a right the local tier does not grant to see it refused.
//
// RIGHTS (M105 spec 04, decision 1). Four levels, in order: `see` < `read` < `send` < `control`. A grant
// of a level holds every level below it ({@link holds}). `see` is lists and states, never the text of a
// screen or a message; `read` adds the text of a session's screen (`read`, always masked); `send` would
// type into a session, `control` would change one. The local tier grants at most `read` ({@link
// LOCAL_TIER_RIGHTS}), the ceiling; a connection holds the level of the run token its `hello` named (spec
// 05, decision 4), never more than the ceiling ({@link lowerOf}). No row in this step needs more than
// `read`, and `send` or `control` needs its own spec, security read and Altan's word. {@link OPERATION_LEVELS} is the level of
// each row, and the table takes its rights from it.
//
// THE EIGHT NAMES. `hello` and `events` are answered here. The other six (`sessions`, `brief`, `read`,
// `accounts`, `hill.list`, `machines`) are declared here, arguments included, and their handlers come in through
// {@link TableDeps.reads}: a row whose handler this bridge was not given is not in its table at all, so
// it is neither offered by `hello` nor callable (`api.unknown_op`). Nothing here reaches a write path:
// the context a handler gets carries no way to type, answer an ask, or change a session.

import type { ApiErrorDetail, ErrorCode } from "../error-codes.ts";
import type { EventBus, SinceAnswer } from "../events/bus.ts";
import { SESSION_ID_MAX } from "../events/session-id.ts";
import type { JsonObject } from "../json.ts";
import { asJsonNumber, asJsonString } from "../../web/src/lib/json.ts";
import { MAX_READ_LINES } from "../read-limits.ts";
import { wireEvent } from "./event-wire.ts";
import { CURSOR_MAX, EVENTS_PER_ANSWER, WAIT_MAX_SECONDS, WAITS_PER_CONNECTION, WAITS_TOTAL } from "./limits.ts";

/** What a caller may be granted, and what a row needs: one level of {@link RIGHT_ORDER}. */
export type Right = "see" | "read" | "send" | "control";

/** The levels, lowest first. A grant of one holds every level before it. */
export const RIGHT_ORDER: readonly Right[] = ["see", "read", "send", "control"];

/** Whether a grant of `granted` holds the level `needed`: the same level, or one above it. */
export function holds(granted: Right, needed: Right): boolean {
  return RIGHT_ORDER.indexOf(granted) >= RIGHT_ORDER.indexOf(needed);
}

/** The ceiling of a caller of the local socket: `read`, which holds `see` (spec 04, decision 1). Read only. */
export const LOCAL_TIER_RIGHTS: Right = "read";

/** The lower of two levels: what a run token of `level` gets under the ceiling `ceiling`. */
export function lowerOf(level: Right, ceiling: Right): Right {
  return holds(ceiling, level) ? level : ceiling;
}

/**
 * A run token as `hello` carries it: exactly 43 base64url characters (32 random bytes, spec 05 decision 1).
 * The socket checks the token against the bridge's table (`ApiSocketDeps.tokens`); this is only how it reads.
 */
export const RUN_TOKEN_TEXT = /^[A-Za-z0-9_-]{43}$/u;

/** The version of the API's wire, in `hello`. */
export const API_VERSION = 1;

/** Every operation name, in the order `hello` lists them. */
export const OPERATION_NAMES = ["hello", "sessions", "brief", "read", "accounts", "hill.list", "machines", "events"] as const;
export type OperationName = (typeof OPERATION_NAMES)[number];

/** The levels a row of this step may need. */
export type ReadLevel = Extract<Right, "see" | "read">;

/**
 * The level each operation needs (spec 04, decision 1): `read` for the screen's text, `see` for every
 * other. {@link DECLARED} takes its rights from here, and a trick's helper (cli/trick-kit/) holds its own
 * copy, which a test compares with this one.
 */
export const OPERATION_LEVELS = {
  hello: "see",
  sessions: "see",
  brief: "see",
  read: "read",
  accounts: "see",
  "hill.list": "see",
  machines: "see",
  events: "see",
} as const satisfies { readonly [K in OperationName]: ReadLevel };

/** The type of one declared argument: text, or a whole number. */
export type ArgType = "string" | "integer";

/**
 * One argument of a row, declared. The command face (`collie api`, cli/api.ts) builds its flags from
 * these, spelled in kebab case, and a row's parser must agree with them: operations.test.ts runs every
 * parser over its own declaration, so an argument a parser takes and no declaration lists, or one a
 * declaration lists and the parser refuses, fails the build.
 */
export interface ArgDecl {
  readonly name: string;
  readonly type: ArgType;
  readonly required: boolean;
  /** One line for the command face's help. */
  readonly help: string;
}

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
  /** The arguments this row takes, for the command face. The row's `parse` takes exactly these. */
  readonly args: readonly ArgDecl[];
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
  readonly args: readonly ArgDecl[];
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
    args: def.args,
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

/** Admit a request by its operation name and the caller's grant. Denies by default: a row whose level the grant does not hold is refused. */
export function admit(table: OperationTable, op: string, granted: Right): Admission {
  const found = table.get(op);
  if (found === undefined) return { ok: false, code: "api.unknown_op" };
  if (!holds(granted, found.right)) return { ok: false, code: "api.denied" };
  return { ok: true, row: found };
}

/** The names a caller with this grant may call, in table order. */
export function offeredOf(table: OperationTable, granted: Right): string[] {
  return [...table.values()].filter((one) => holds(granted, one.right)).map((one) => one.name);
}

// ── The arguments ────────────────────────────────────────────────────────────────────────────────

/** No arguments. */
export type NoArgs = Readonly<Record<string, never>>;

/**
 * `hello`: the run token of the trick's run, from its facts (`api.token`, spec 05 decision 3). The socket
 * reads it before the row runs and binds the connection to it; the handler never sees it again. `client`,
 * the caller's own name of spec 04, is gone: the log names the trick the token belongs to (decision 5).
 */
export interface HelloArgs {
  readonly token: string;
}

/** One session, by its opaque id (ids.ts resolves it). */
export interface SessionArgs {
  readonly session: string;
}

/** `read`: one session, and how many lines of its screen (absent: the bridge's own default, `COLLIE_READ_LINES`). */
export interface ReadArgs {
  readonly session: string;
  readonly lines: number | undefined;
}

export interface EventsArgs {
  /** The cursor to resume after; absent: start at now. */
  readonly after: string | undefined;
  /** How long to wait for an event when there is none, in whole seconds. */
  readonly wait: number;
}

/** The argument type of each operation. */
export interface ArgsOf {
  hello: HelloArgs;
  sessions: NoArgs;
  brief: SessionArgs;
  read: ReadArgs;
  accounts: NoArgs;
  "hill.list": NoArgs;
  machines: NoArgs;
  events: EventsArgs;
}

function onlyKeys(input: JsonObject, allowed: readonly string[]): boolean {
  return Object.keys(input).every((key) => allowed.includes(key));
}

function parseNone(input: JsonObject): Parsed<NoArgs> {
  if (!onlyKeys(input, [])) return { ok: false, reason: "this operation takes no arguments" };
  return { ok: true, args: {} };
}

function parseHello(input: JsonObject): Parsed<HelloArgs> {
  if (!onlyKeys(input, ["token"])) return { ok: false, reason: "an argument this operation does not take" };
  const token = asJsonString(input.token);
  if (token === undefined || !RUN_TOKEN_TEXT.test(token)) return { ok: false, reason: "args.token must be the run token of the trick's facts" };
  return { ok: true, args: { token } };
}

function parseSession(input: JsonObject): Parsed<SessionArgs> {
  if (!onlyKeys(input, ["session"])) return { ok: false, reason: "an argument this operation does not take" };
  const session = asJsonString(input.session);
  if (session === undefined || session === "") return { ok: false, reason: "args.session must be a session id from sessions" };
  if (session.length > SESSION_ID_MAX) return { ok: false, reason: "args.session is too long to be a session id" };
  return { ok: true, args: { session } };
}

function parseRead(input: JsonObject): Parsed<ReadArgs> {
  if (!onlyKeys(input, ["session", "lines"])) return { ok: false, reason: "an argument this operation does not take" };
  const parsed = parseSession({ session: input.session });
  if (!parsed.ok) return parsed;
  if (input.lines === undefined) return { ok: true, args: { session: parsed.args.session, lines: undefined } };
  const lines = asJsonNumber(input.lines);
  if (lines === undefined || !Number.isInteger(lines) || lines < 1 || lines > MAX_READ_LINES) {
    return { ok: false, reason: `args.lines must be a whole number from 1 to ${String(MAX_READ_LINES)}` };
  }
  return { ok: true, args: { session: parsed.args.session, lines } };
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

const SESSION_ARG: ArgDecl = { name: "session", type: "string", required: true, help: "A session id, copied from sessions." };

/** Every operation, declared. */
export const DECLARED: Declarations = {
  hello: {
    name: "hello",
    kind: "read",
    right: OPERATION_LEVELS.hello,
    waits: false,
    summary: "The API version, the Collie version and the operations offered. First on every connection.",
    args: [{ name: "token", type: "string", required: true, help: "The run token of a trick's run, from its facts (api.token). Never logged." }],
    parse: parseHello,
  },
  sessions: { name: "sessions", kind: "read", right: OPERATION_LEVELS.sessions, waits: false, summary: "The agent sessions of this machine.", args: [], parse: parseNone },
  brief: { name: "brief", kind: "read", right: OPERATION_LEVELS.brief, waits: false, summary: "The state of one session, with no text.", args: [SESSION_ARG], parse: parseSession },
  read: {
    name: "read",
    kind: "read",
    right: OPERATION_LEVELS.read,
    waits: false,
    summary: "The screen of one session, secrets masked, capped.",
    args: [SESSION_ARG, { name: "lines", type: "integer", required: false, help: `How many lines of the screen, 1 to ${String(MAX_READ_LINES)}. Default: the bridge's own.` }],
    parse: parseRead,
  },
  accounts: { name: "accounts", kind: "read", right: OPERATION_LEVELS.accounts, waits: false, summary: "The agent accounts of this machine.", args: [], parse: parseNone },
  "hill.list": { name: "hill.list", kind: "read", right: OPERATION_LEVELS["hill.list"], waits: false, summary: "The open decisions on the Hill, with no body.", args: [], parse: parseNone },
  machines: { name: "machines", kind: "read", right: OPERATION_LEVELS.machines, waits: false, summary: "The machines of the crew, with their load, as the Machines page knows them.", args: [], parse: parseNone },
  events: {
    name: "events",
    kind: "read",
    right: OPERATION_LEVELS.events,
    waits: true,
    summary: "The events after a cursor, waiting up to 25 seconds for one.",
    args: [
      { name: "after", type: "string", required: false, help: "The cursor of an earlier answer. Default: now." },
      { name: "wait", type: "integer", required: false, help: `Seconds to wait when there is no event, 0 to ${String(WAIT_MAX_SECONDS)}. Default: 0.` },
    ],
    parse: parseEvents,
  },
};

/** A handler of each operation. */
export type Handlers = { readonly [K in OperationName]: (args: ArgsOf[K], ctx: OperationContext) => Promise<OpResult> };

/** The six read operations whose handlers come from outside this file. */
export type ReadName = "sessions" | "brief" | "read" | "accounts" | "hill.list" | "machines";
export type ReadHandlers = Pick<Handlers, ReadName>;

export interface TableDeps {
  /** The Collie version, as the bridge reports it (bridge/version.ts). */
  readonly version: () => string;
  /** The event bus, read only. */
  readonly bus: Pick<EventBus, "since" | "waitFor">;
  /** The six read handlers. One left out is not offered on this bridge. */
  readonly reads?: Partial<ReadHandlers>;
}

function bind<K extends OperationName>(name: K, handler: Handlers[K] | undefined): TableRow | null {
  if (handler === undefined) return null;
  return row<ArgsOf[K]>({ ...DECLARED[name], handle: handler });
}

/**
 * `hello` (decision 17): what this socket is and what the caller may call at its token's level. The socket
 * has checked the token and bound the connection before this runs (spec 05, decision 3); the answer never
 * carries the token.
 */
function hello(deps: TableDeps): Handlers["hello"] {
  return async (_args, ctx) => {
    return { ok: true, answer: { api: API_VERSION, collie: deps.version(), experimental: true, operations: [...ctx.offered] } };
  };
}

/**
 * One page of a pull: at most {@link EVENTS_PER_ANSWER} events, a `gap` or `reset` marker counted, so an
 * answer after a reset (every buffered event, up to 2048) never passes the socket's 1 MiB cap. When events
 * are left, `next` is the cursor of the last event answered, and the caller pages on from there; a marker's
 * own cursor sits just before the oldest kept event, so a page that ends on it loses nothing.
 */
function page(answer: SinceAnswer): OpResult {
  const kept = answer.events.slice(0, EVENTS_PER_ANSWER);
  const last = kept.at(-1);
  const next = answer.events.length > kept.length && last !== undefined ? last.cursor : answer.next;
  return { ok: true, answer: { events: kept.map(wireEvent), next } };
}

/**
 * `events` (decision 17): the events after `after`; with none and `wait` > 0, one wait on the bus for
 * the next, then the events again. The wait takes a slot (decision 18), ends early on the connection's
 * close or the socket's stop, and checks at its wake that the socket still stands.
 */
function events(deps: TableDeps): Handlers["events"] {
  return async (args, ctx) => {
    const first = deps.bus.since(args.after);
    if (first.events.length > 0 || args.wait === 0) return page(first);
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
    return page(deps.bus.since(from));
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
    case "machines":
      return bind(name, handlers.machines);
    case "events":
      return bind(name, handlers.events);
    default: {
      const never: never = name;
      throw new TypeError(`api: an unknown operation ${String(never)}`);
    }
  }
}

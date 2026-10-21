// The Collie wire for a host with no process of its own (M66, WIRE.md appendix "A host with no process"): one
// function from a web `Request` to a `Response` that builds the state it needs from the World, answers through the
// core's `handle`, and drops the state. Nothing the phone can see lives in this function between two requests, so two
// instances behind one URL (two Vercel functions, two Node processes) answer alike.
//
// Per request, in this order: the bearer token (a bare 401 before anything is read); the route; the facts that route
// needs and nothing more (hello: is the World there; snapshot: every open pane and its journal; a pane's routes: that
// pane); a core `Store` built from them through the seams (`epoch`, `rev`, a fixed `turnId` and `cursor` per pane, asks
// seeded from the journal's fold); `handle`; the receipts of the acts written back to the journal; the answer.
//
// `createRoute` takes any {@link WireSource}; `collieRoute` is it on the Pi variant of durable-harness (`pi-source.ts`).
// A kernel source is another file, not a rewrite of this one. Erasable TypeScript only, so Node runs it as it is.

import { foldJournal, type FoldedJournal, type JournalRecord, type SeededAsk } from "../core/journal.ts";
import { randomHex, sha256Hex } from "../core/hash.ts";
import { type CoreState, handle } from "../core/handle.ts";
import type { AskSink, Pane, SinkReply } from "../core/layout.ts";
import { Store } from "../core/layout.ts";
import { type Claim, HttpError, type ReceiptRecord, type ReceiptStore } from "../core/receipts.ts";
import { idOk } from "../core/rules.ts";
import type { Badge, Caps, HistoryProvider, Item, PaneState, ProgramHooks, Progress } from "../core/types.ts";
import { PROTOCOL_RANGE } from "../core/types.ts";
import { WIRE_VERSION } from "../core/index.ts";
import { piSource } from "./pi-source.ts";
import { takeoverControls } from "./with-collie.ts";
import { createWorldPort, type Opener, type World, type WorldPort, type WorldPortOptions } from "./world-port.ts";

// ── what a source gives ──────────────────────────────────────────────────────────────────────────────────────────────

/** One open conversation, as the source derives it from its log. */
export interface PaneFacts {
  /** The pane id on the wire. */
  id: string;
  /** The run whose journal holds this pane's asks and request ids. */
  journal: string;
  workspaceId: string;
  /** The tab's own id inside its workspace (the wire's tab id is `<workspace>:<tab>`). */
  tabId: string;
  title: string;
  harness: string;
  cwd?: string;
  /** The program's own state. `waiting` is the core's, from the open asks. */
  state: Extract<PaneState, "idle" | "working">;
  /** A fact of the log: the same on every instance (WIRE.md A.1). */
  turnId: string;
  /** A whole number from 0 that rises with every change the source shows, and never falls inside a run. */
  rev: number;
  /** Epoch milliseconds. */
  lastActiveAt: number;
  subtitle?: string;
  badge?: Badge;
  progress?: Progress;
  /** The id the history serves this conversation under. Left out: the pane id. */
  sessionId?: string;
}

/** The layout of the open conversations. */
export interface SourceLayout {
  workspaces: { id: string; title: string; cwd?: string }[];
  tabs: { id: string; workspaceId: string; title: string }[];
  panes: PaneFacts[];
  /** The source's own share of the snapshot's `rev`, for what no pane carries (the Pi source: the number of runs). */
  rev: number;
}

/**
 * Where the wire's facts come from. Every method reads; none keeps what the phone sees between two calls. A source
 * that cannot reach its log throws, and the route answers 503 `starting` (or a stale answer, see {@link RouteOptions}).
 */
export interface WireSource {
  /** What the source can serve on its own: `asks` from its journal, `history` when it has one. Acts come from {@link Controls}. */
  readonly caps: Pick<Caps, "asks" | "history">;
  /** The source's schema and World, for the epoch: it changes only when the meaning of a cursor changes. */
  identity(): string | Promise<string>;
  /** Resolves when the log answers. Hello calls it, and reads nothing else. */
  ready(): Promise<void>;
  /** Every open conversation. */
  layout(): Promise<SourceLayout>;
  /** One open conversation, with its items when asked; undefined when it is not open (or not this program's). */
  pane(id: string, withItems: boolean): Promise<(PaneFacts & { items?: Item[] }) | undefined>;
  /** The program's own record of every conversation, open and closed (WIRE.md 7.16). */
  history?: HistoryProvider;
}

/** The journal of a run, as the World keeps it (`world-port.ts`). */
export interface JournalPort {
  appendJournal(runId: string, record: JournalRecord): Promise<void>;
  readJournal(runId: string): Promise<JournalRecord[]>;
}

/** One act on one pane, as the route hands it to the controls. */
export interface ControlCall {
  paneId: string;
  /** The run the pane shows. */
  journal: string;
  /** The turn the request named, already checked against the log as the route read it. Check it again after taking the session. */
  turnId: string;
  requestId: string;
}

/**
 * How the phone's acts reach the program. Each may throw an `HttpError` (409 `stale` when the turn moved). A control
 * that is absent turns its cap off. Left out entirely: `takeoverControls(open)` when the route has the opener.
 */
export interface Controls {
  send?(call: ControlCall & { text: string; steer: boolean }): Promise<void>;
  abort?(call: ControlCall): Promise<void>;
}

// ── the bearer token (copied from experiments/durable-member-cloudflare/src/token.ts) ────────────────────────────────

/** The shortest token the route accepts, in bytes. Collie demands the same of COLLIE_DURABLE_TOKEN. */
export const TOKEN_MIN_BYTES = 32;

const encoder = new TextEncoder();
const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(s)));

/** A configured token that may be used: set, and at least 32 bytes. Anything else matches no request. */
const usable = (configured: string | undefined): configured is string => configured !== undefined && encoder.encode(configured).byteLength >= TOKEN_MIN_BYTES;

/** Two digests compared in constant time: every byte is read, whatever differs first. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * True when `Authorization: Bearer <token>` carries `token`, or `next` while a rotation runs. Each is hashed first,
 * so every compare runs over 32 bytes and in constant time, whatever the length of the guess, and both are always
 * compared, so the time does not say which one matched.
 */
export async function tokenAccepted(request: Request, token: string | undefined, next?: string): Promise<boolean> {
  const tokens = [token, next].filter(usable);
  if (tokens.length === 0) return false; // fail closed
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  const [guess, held] = await Promise.all([digest(match?.[1] ?? ""), Promise.all(tokens.map(digest))]);
  // An empty guess never matches: every usable token is 32 bytes or more.
  return held.map((b) => sameBytes(guess, b)).includes(true);
}

/** The answer to a missing or wrong token: 401 and nothing else, no range, no epoch, no route. */
const refused = () => new Response(JSON.stringify({ code: "unauthorized" }), { status: 401, headers: { "content-type": "application/json", "www-authenticate": "Bearer" } });

// ── the route ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RouteOptions {
  source: WireSource;
  journal: JournalPort;
  /** The bearer token, at least 32 bytes. Without a usable one every request is 401. */
  token: string | undefined;
  /** The next token while a rotation runs: both are accepted. */
  tokenNext?: string;
  hostName: string;
  /** The program's name, in the epoch. */
  name: string;
  /**
   * The caps to offer, as the core reads them: a cap not named is false. Left out: `asks`, `send`, `abort` and
   * `history` as far as the source and the controls serve them. Whatever is given, `rename`, `close`, `reopen`,
   * `actions` and `starters` stay false (this host has no store of its own for them), and so does a cap whose control
   * or source is missing. `steer` true lets a send join a running turn; false (the default) refuses a send while a
   * turn runs or a question waits.
   */
  caps?: Caps;
  controls?: Controls;
  /** The epoch, as is. Else `COLLIE_EPOCH`, else a hash of the wire version, the source's identity and `name`. Never random. */
  epoch?: string;
  /** How long a GET may be answered from the last good answer while the World errs. Default 5000 ms; then 503 `starting`. */
  staleMs?: number;
  /** How long a writer waits to see its own record in the journal before it gives up. Default 4000 ms. */
  readBackMs?: number;
  /** Runs once, before the first request is read (the World port's version check). A throw answers every request 500 with its line. */
  preflight?: () => Promise<void>;
  /** Where the route writes its one-line notes. Default `console.warn`. */
  warn?: (line: string) => void;
  /** The clock, for tests. */
  now?: () => number;
}

/** What the route loads for one request. */
type Plan = { kind: "none" } | { kind: "hello" } | { kind: "snapshot" } | { kind: "pane"; id: string; items: boolean } | { kind: "history" };

const decode = (s: string): string | undefined => {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
};

function planOf(method: string, route: string[]): Plan {
  if (method === "GET" && route.length === 1 && route[0] === "hello") return { kind: "hello" };
  if (method === "GET" && route.length === 1 && route[0] === "snapshot") return { kind: "snapshot" };
  if (route[0] === "pane" && route.length === 3) {
    const id = decode(route[1]!);
    if (id === undefined || !idOk(id)) return { kind: "none" };
    return { kind: "pane", id, items: method === "GET" && route[2] === "events" };
  }
  if (method === "GET" && (route[0] === "conversations" || route[0] === "conversation")) return { kind: "history" };
  return { kind: "none" };
}

/** What a request id's standing receipt in the journal tells the core. */
const claimOf = (r: { phase: string; digest: string; reply?: object }): Claim =>
  r.phase === "done" ? { state: "done", digest: r.digest, reply: r.reply ?? {} } : { state: "pending", digest: r.digest };

/** Open asks past their `expiresAt` that no record closed yet: the reader closes them, so they move the cursor too. */
const lapsed = (open: readonly SeededAsk[], at: number) => open.filter((a) => a.expiresAt !== undefined && Date.parse(a.expiresAt) <= at).length;

// SAFETY: `process` is Node's and Bun's; on a runtime without one it is absent, which the optional reads allow.
const envOf = (name: string): string | undefined => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A GET answered before, kept per instance so a short World outage reads as the last good answer, not as unreachable. */
interface Kept {
  status: number;
  headers: [string, string][];
  body: string;
  at: number;
}

/** What a request claimed in the journal, and whether its act came back with a reply. */
interface Claimed {
  runId: string;
  group: string;
  digest: string;
  nonce: string;
  reply?: object;
}

/** The facts of a request's panes and their journals. */
interface Loaded {
  layout: SourceLayout;
  journals: Map<string, JournalRecord[]>;
  items: Map<string, Item[]>;
}

/** The most GET answers one instance keeps for an outage. An events answer can hold a reset view of up to 8 MiB. */
export const KEPT_MAX = 64;

/**
 * For tests only, not exported by the entry: the route answers `route[KEPT_SIZE]()` with how many answers it keeps.
 * The key of an events answer holds its cursor, so a server that runs for days must not keep them all.
 */
export const KEPT_SIZE: unique symbol = Symbol("collie.keptSize");

export function createRoute(o: RouteOptions): (request: Request) => Promise<Response> {
  const now = o.now ?? Date.now;
  const staleMs = o.staleMs ?? 5000;
  const readBackMs = o.readBackMs ?? 4000;
  const warn = o.warn ?? ((line: string) => console.warn(line));
  // Keyed by method, path and search: a stale events answer must match the cursor the phone asked for.
  const kept = new Map<string, Kept>();
  /** Keep a good answer: drop every one older than `staleMs`, then the oldest past {@link KEPT_MAX}. */
  const keep = (key: string, entry: Kept) => {
    for (const [k, v] of kept) if (entry.at - v.at > staleMs) kept.delete(k);
    kept.delete(key);
    kept.set(key, entry);
    while (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value!);
  };
  let epochOf: Promise<string> | undefined;
  let preflight: Promise<void> | undefined;

  const caps: Caps = (() => {
    const want = o.caps ?? { asks: true, send: true, abort: true, history: true };
    return {
      asks: want.asks === true && o.source.caps.asks === true,
      starters: false,
      send: want.send === true && o.controls?.send !== undefined,
      steer: want.steer === true && o.controls?.send !== undefined,
      abort: want.abort === true && o.controls?.abort !== undefined,
      rename: false,
      close: false,
      actions: false,
      // Read again per request (`build`): a source may gain its history after the route is made.
      history: want.history === true && o.source.caps.history === true,
      reopen: false,
      terminal: false,
    };
  })();

  async function epoch(): Promise<string> {
    epochOf ??= (async () => {
      const named = o.epoch ?? envOf("COLLIE_EPOCH");
      if (named !== undefined) {
        if (!idOk(named)) throw new TypeError(`collie: the epoch breaks the id rule: ${JSON.stringify(named)}`);
        return named;
      }
      return sha256Hex(`${WIRE_VERSION}\n${await o.source.identity()}\n${o.name}`).slice(0, 32);
    })();
    return epochOf;
  }

  /** Read the journal until `seen` holds, for a World whose reads lag its writes. A prefix of the stream is never wrong, only short. */
  async function readBack(runId: string, seen: (f: FoldedJournal) => boolean): Promise<FoldedJournal> {
    const until = now() + readBackMs;
    for (let wait = 25; ; wait = Math.min(wait * 2, 400)) {
      const folded = foldJournal(await o.journal.readJournal(runId));
      if (seen(folded)) return folded;
      if (now() >= until) throw new Error(`collie: the journal of ${runId} did not show a record written ${readBackMs} ms ago`);
      await sleep(wait);
    }
  }

  /** The request ids of one request, in the journal: `pending` before the act, `done` or `failed` after it (the route writes those). */
  class JournalReceipts implements ReceiptStore {
    readonly claims = new Map<string, Claimed>();
    private readonly runOf: (group: string) => string | undefined;
    constructor(runOf: (group: string) => string | undefined) {
      this.runOf = runOf;
    }
    get(): undefined {
      // Never read: a store with `claim` is asked through `claim` only.
      return undefined;
    }
    put(requestId: string, record: ReceiptRecord): void {
      const claim = this.claims.get(requestId);
      if (claim !== undefined) claim.reply = record.reply;
    }
    async claim(requestId: string, digestOfAct: string, group: string): Promise<Claim> {
      const runId = this.runOf(group);
      // Every act this host offers is on a pane. A group with no run is a route whose cap is false, refused before here.
      if (runId === undefined) throw new HttpError(409, "not-supported");
      const known = foldJournal(await o.journal.readJournal(runId)).receipts.get(requestId);
      if (known !== undefined) return claimOf(known);
      const nonce = randomHex(16);
      await o.journal.appendJournal(runId, { t: "receipt", phase: "pending", group, requestId, digest: digestOfAct, nonce, at: new Date(now()).toISOString() });
      let folded: FoldedJournal;
      try {
        folded = await readBack(runId, (f) => f.receipts.has(requestId));
      } catch (e) {
        // Our `pending` may still land. Free the id, so a repeat is not refused for good.
        await o.journal.appendJournal(runId, { t: "receipt", phase: "failed", group, requestId, digest: digestOfAct, nonce, at: new Date(now()).toISOString() }).catch(() => {});
        throw e;
      }
      const standing = folded.receipts.get(requestId)!;
      if (standing.phase === "pending" && standing.nonce === nonce) {
        this.claims.set(requestId, { runId, group, digest: digestOfAct, nonce });
        return { state: "new" };
      }
      return claimOf(standing);
    }
  }

  /** Where an answer to a seeded ask goes: an `answer` record, then the journal read back for the record that won. */
  const sinkOf = (runId: string): AskSink => ({
    async answer(askId, revision, answer, requestId): Promise<SinkReply> {
      const nonce = randomHex(16);
      const at = new Date(now()).toISOString();
      await o.journal.appendJournal(runId, { t: "answer", askId, revision, answer, requestId, nonce, at });
      const folded = await readBack(runId, (f) => f.winners.has(askId));
      const winner = folded.winners.get(askId)!;
      if (winner.t === "answer" && winner.nonce === nonce) return { taken: true, at };
      return { taken: false, decided: folded.decided.get(askId)! };
    },
  });

  async function load(plan: Plan): Promise<Loaded | undefined> {
    if (plan.kind === "hello") {
      await o.source.ready();
      return undefined;
    }
    if (plan.kind === "snapshot") {
      const layout = await o.source.layout();
      const journals = new Map<string, JournalRecord[]>();
      await Promise.all(layout.panes.map(async (p) => journals.set(p.journal, await o.journal.readJournal(p.journal))));
      return { layout, journals, items: new Map() };
    }
    if (plan.kind === "pane") {
      const facts = await o.source.pane(plan.id, plan.items);
      const empty: SourceLayout = { workspaces: [], tabs: [], panes: [], rev: 0 };
      if (facts === undefined) return { layout: empty, journals: new Map(), items: new Map() };
      const { items, ...pane } = facts;
      const layout: SourceLayout = {
        workspaces: [{ id: pane.workspaceId, title: pane.workspaceId }],
        tabs: [{ id: pane.tabId, workspaceId: pane.workspaceId, title: pane.tabId }],
        panes: [pane],
        rev: 0,
      };
      return { layout, journals: new Map([[pane.journal, await o.journal.readJournal(pane.journal)]]), items: new Map(items === undefined ? [] : [[pane.id, items]]) };
    }
    return undefined;
  }

  /** The per-request state: a core store built from the facts through the seams. Thrown away after the answer. */
  function build(loaded: Loaded | undefined, ready: boolean, epochNow: string, receipts: JournalReceipts, factsById: Map<string, PaneFacts>): CoreState {
    const at = now();
    let rev = 1;
    const store = new Store(undefined, receipts, false, { epoch: epochNow, rev: () => rev });
    const hooks: ProgramHooks = {};
    const controls = o.controls;
    if (controls?.send !== undefined) {
      const send = controls.send.bind(controls);
      hooks.onSend = async (ref, s) => {
        const facts = factsById.get(ref.id)!;
        await send({ paneId: ref.id, journal: facts.journal, turnId: s.turnId, requestId: s.requestId, text: s.text, steer: s.steer });
      };
    }
    if (controls?.abort !== undefined) {
      const abort = controls.abort.bind(controls);
      hooks.onAbort = async (ref, s) => {
        const facts = factsById.get(ref.id)!;
        await abort({ paneId: ref.id, journal: facts.journal, turnId: s.turnId, requestId: s.requestId });
        // The turn is gone, and with it every question it asked: each closes as decided by the program (WIRE.md A.2).
        const open = foldJournal(await o.journal.readJournal(facts.journal)).open;
        const stamp = new Date(now()).toISOString();
        for (const ask of open) await o.journal.appendJournal(facts.journal, { t: "expire", askId: ask.askId, at: stamp, decidedBy: "program" });
      };
    }
    store.hooks = hooks;
    const history = caps.history ? o.source.history : undefined;
    if (history !== undefined) store.history = worldErrorsAsStarting(history);
    if (loaded !== undefined) {
      const { layout } = loaded;
      rev += layout.rev;
      const tabs = new Map<string, ReturnType<ReturnType<Store["workspace"]>["tab"]>>();
      for (const ws of layout.workspaces) {
        const made = store.workspace(ws.id, ws.cwd === undefined ? { title: ws.title } : { title: ws.title, cwd: ws.cwd });
        for (const tab of layout.tabs) if (tab.workspaceId === ws.id) tabs.set(`${ws.id}:${tab.id}`, made.tab(tab.id, { title: tab.title }));
      }
      for (const facts of layout.panes) {
        const tab = tabs.get(`${facts.workspaceId}:${facts.tabId}`);
        if (tab === undefined) continue;
        factsById.set(facts.id, facts);
        const records = loaded.journals.get(facts.journal) ?? [];
        const folded = foldJournal(records);
        const cursor = facts.rev + records.length + lapsed(folded.open, at);
        rev += cursor;
        const options: Parameters<typeof tab.pane>[1] = { title: facts.title, harness: facts.harness, turnId: facts.turnId, sendWhenIdleOnly: !caps.steer, cursor };
        if (facts.cwd !== undefined) options.cwd = facts.cwd;
        // The history serves a conversation under its pane id, so the open pane and its history row are one conversation.
        if (history !== undefined) options.sessionId = facts.sessionId ?? facts.id;
        // SAFETY: the store's pane handles are its Pane objects; the route needs `lastActiveAt`, which the handle does not show.
        const pane = tab.pane(facts.id, options) as Pane;
        pane.state(facts.state);
        if (facts.subtitle !== undefined) pane.subtitle(facts.subtitle);
        if (facts.badge !== undefined) pane.badge(facts.badge);
        if (facts.progress !== undefined) pane.progress(facts.progress);
        for (const item of loaded.items.get(facts.id) ?? []) {
          try {
            pane.event({ type: "item", item });
          } catch (e) {
            warn(`collie: pane ${facts.id}: an item was dropped: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        pane.seedDecided(folded.decided);
        const sink = sinkOf(facts.journal);
        for (const ask of folded.open) {
          try {
            pane.seedAsk(ask, sink);
          } catch (e) {
            // One bad record must not take the pane down with it: the journal is as writable as the World.
            warn(`collie: pane ${facts.id}: the ask ${ask.askId} in the journal was not shown: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        pane.lastActiveAt = facts.lastActiveAt;
      }
    }
    store.ready = ready;
    return { store, hostName: o.hostName, caps: { ...caps, history: history !== undefined }, hooks, warn };
  }

  const serve = async (request: Request): Promise<Response> => {
    if (!(await tokenAccepted(request, o.token, o.tokenNext))) return refused();
    if (o.preflight !== undefined) {
      preflight ??= o.preflight();
      try {
        await preflight;
      } catch (e) {
        preflight = undefined;
        return new Response(JSON.stringify({ code: "internal", message: e instanceof Error ? e.message : String(e) }), { status: 500, headers: { "content-type": "application/json" } });
      }
    }
    const url = new URL(request.url);
    const mount = url.pathname.indexOf("/session/v1");
    if (mount < 0) return new Response(JSON.stringify({ code: "not-found" }), { status: 404, headers: { "content-type": "application/json" } });
    const path = url.pathname.slice(mount);
    // The core reads the path from `/session/v1` on: the same request under the URL it expects. A body is at most what
    // the core reads anyway (it reads past 64 KiB to answer 413).
    const payload = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    const init: RequestInit = { method: request.method, headers: request.headers };
    if (payload !== undefined) init.body = payload;
    const inner = new Request(`${url.origin}${path}${url.search}`, init);
    const route = path.split("/").filter(Boolean).slice(2);

    // A version Collie does not speak, on any route but hello, is 409 from the core. Nothing is read for it.
    const header = request.headers.get("x-collie-session");
    const version = header !== null && /^\d+$/.test(header) ? Number(header) : undefined;
    const speaks = version !== undefined && version >= PROTOCOL_RANGE.min && version <= PROTOCOL_RANGE.max;
    const plan: Plan = speaks || (route.length === 1 && route[0] === "hello") ? planOf(request.method, route) : { kind: "none" };

    const key = `${request.method} ${path}${url.search}`;
    let epochNow: string;
    let loaded: Loaded | undefined;
    let ready = true;
    try {
      epochNow = await epoch();
      loaded = await load(plan);
    } catch (e) {
      if (e instanceof TypeError && String(e.message).startsWith("collie: the epoch")) throw e;
      warn(`collie: the World did not answer: ${e instanceof Error ? e.message : String(e)}`);
      if (request.method === "GET") {
        const stale = fromKept(key, request);
        if (stale !== undefined) return stale;
      }
      if (plan.kind !== "hello" || epochOf === undefined) return new Response(JSON.stringify({ code: "starting" }), { status: 503, headers: { "content-type": "application/json" } });
      epochNow = await epochOf;
      ready = false;
    }

    const factsById = new Map<string, PaneFacts>();
    const receipts = new JournalReceipts((group) => factsById.get(group)?.journal);
    const state = build(loaded, ready, epochNow, receipts, factsById);
    const response = await handle(inner, state);

    // The receipts: `done` with the reply for an act that answered, `failed` for one that refused, so its id is free again.
    try {
      for (const [requestId, c] of receipts.claims) {
        const at = new Date(now()).toISOString();
        if (c.reply !== undefined) await o.journal.appendJournal(c.runId, { t: "receipt", phase: "done", group: c.group, requestId, digest: c.digest, reply: c.reply, nonce: c.nonce, at });
        else await o.journal.appendJournal(c.runId, { t: "receipt", phase: "failed", group: c.group, requestId, digest: c.digest, nonce: c.nonce, at });
      }
    } catch (e) {
      // The act ran and its receipt is not written: its outcome is unknown to a repeat, which waits and then says so (WIRE.md 7.6).
      warn(`collie: a receipt was not written: ${e instanceof Error ? e.message : String(e)}`);
      return new Response(JSON.stringify({ code: "internal" }), { status: 500, headers: { "content-type": "application/json" } });
    }

    if (request.method !== "GET") return response;
    if (response.status === 503) return fromKept(key, request) ?? response;
    const body = await response.text();
    const headers = [...response.headers.entries()];
    if (response.status === 200) keep(key, { status: response.status, headers, body, at: now() });
    return new Response(response.status === 304 ? null : body, { status: response.status, headers });
  };

  return Object.assign(serve, { [KEPT_SIZE]: () => kept.size });

  /** The last good answer to the same GET, while it is younger than `staleMs`. A snapshot's ETag still gets its 304. */
  function fromKept(key: string, request: Request): Response | undefined {
    const have = kept.get(key);
    if (have === undefined || now() - have.at > staleMs) return undefined;
    const etag = have.headers.find(([name]) => name.toLowerCase() === "etag")?.[1];
    const match = request.headers.get("if-none-match");
    if (etag !== undefined && match !== null && match.trim().replace(/^W\//, "") === etag) return new Response(null, { status: 304, headers: { etag } });
    return new Response(have.body, { status: have.status, headers: have.headers });
  }
}

/** A failed history read: an `HttpError` as it is, anything else (the World) 503 `starting`, as every other route. */
function asStarting(e: Error): never {
  if (e instanceof HttpError) throw e;
  throw new HttpError(503, "starting");
}

/** A history whose reads fail on the World answers 503 `starting`, as every other route does, and not 500. */
function worldErrorsAsStarting(history: HistoryProvider): HistoryProvider {
  return {
    list: (after, limit) => Promise.resolve(history.list(after, limit)).catch(asStarting),
    items: (id, after, limit) => Promise.resolve(history.items(id, after, limit)).catch(asStarting),
  };
}

// ── the durable-harness Pi route ─────────────────────────────────────────────────────────────────────────────────────

export interface CollieRouteOptions extends Omit<RouteOptions, "source" | "journal" | "hostName" | "name" | "preflight"> {
  /**
   * The opener `withCollie` returned (and `resumeWith` registered). With it, send and stop take the session over
   * (`takeoverControls`) unless `controls` says otherwise. Without it and without `controls`, the phone can read and
   * answer, and not send or stop.
   */
  open?: Opener;
  /** The opener's name, as given to `resumeWith(open, { name })`. Default `pi-durable`. */
  name?: string;
  /** What Collie calls this host. Default: the name. */
  hostName?: string;
  /** The World. Left out: the environment's (`getWorld()`). */
  world?: World;
  /** The whole World port, for a test or a custom World. Wins over `world` and `open`. */
  port?: WorldPort;
}

/**
 * The Collie wire for a durable-harness Pi program, as one web handler: mount it under any path that ends in
 * `/session/v1` (Next.js `app/collie/session/v1/[...path]/route.ts`, a Vercel function, a Node server).
 *
 * ```ts
 * const route = collieRoute({ open, token: process.env.COLLIE_TOKEN });
 * export const GET = route, POST = route;
 * ```
 */
export function collieRoute(o: CollieRouteOptions): (request: Request) => Promise<Response> {
  const name = o.name ?? "pi-durable";
  const portOptions: WorldPortOptions = {};
  if (o.world !== undefined) portOptions.world = o.world;
  if (o.open !== undefined) portOptions.open = o.open;
  const port = o.port ?? createWorldPort(portOptions);
  const controls = o.controls ?? (o.open === undefined ? undefined : takeoverControls(o.open, { port }));
  const { open: _open, world: _world, port: _port, name: _name, hostName, ...rest } = o;
  const options: RouteOptions = { ...rest, source: piSource({ port, name }), journal: port, hostName: hostName ?? name, name, preflight: () => port.checkVersions() };
  if (controls !== undefined) options.controls = controls;
  return createRoute(options);
}

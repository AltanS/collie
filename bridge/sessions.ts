import { basename, dirname } from "node:path";

import type { EventPoker } from "./event-poker.ts";
import type { MuxAdapter } from "./mux/types.ts";
import type { NotificationCoordinator } from "./notifications.ts";
import type { StateEngine } from "./state-engine.ts";
import type { SessionSummary } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Multi-session support. A multiplexer may run several instances on one machine, each
// with its own endpoint. ONE bridge process fronts N of them. The primary session
// (cfg.socketPath) maps to all of today's behaviour; everything else is additive and
// opt-in.
//
// WHERE THOSE INSTANCES ARE IS THE ADAPTER'S ANSWER, never this file's. `refresh()`
// asks the primary adapter's `listSessions` capability and starts a runtime per answer;
// an adapter that declares the capability absent refuses, and the registry then pins to
// the primary for good. That is what makes this module free of any one multiplexer's
// layout, Herdr's socket shape lives in bridge/mux/herdr/sessions.ts (ADR 0022,
// ADR 0036, M22/02). What stays here is the registry, the naming rules and the
// browser-facing selection.
//
// SECURITY: a client-supplied session name is ONLY ever a Map key lookup here — it is
// NEVER used to build a path, and no path is built here at all. The name a browser sends
// can only select among what the adapter already reported.
// ─────────────────────────────────────────────────────────────────────────────

/** The default session's name, the one whose endpoint sits directly in the config root. */
export const DEFAULT_SESSION_NAME = "default";
/** The base notification tag; the whole herd of one session shares this slot. */
const HERD_TAG_BASE = "collie:herd";

/**
 * The herd notification tag for a session. The primary keeps the bare `collie:herd` (so
 * notifications outstanding from before this feature don't orphan); every other session gets
 * `collie:herd:<name>` so its alerts occupy their own slot. Pure + exported for tests.
 */
export function herdTagFor(isPrimary: boolean, name: string): string {
  return isPrimary ? HERD_TAG_BASE : `${HERD_TAG_BASE}:${name}`;
}

/**
 * The registry name for a session's endpoint, relative to a config root: `"default"` when the
 * endpoint sits directly in the root, else the name of the directory holding it. Pure + exported for
 * tests.
 *
 * A NAMING RULE, not a layout: it reads the endpoint the operator configured and never builds a
 * path. Which endpoints exist is the adapter's answer ({@link MuxAdapter.listSessions}), and every
 * discovered session is named by the adapter that found it, so this is only ever asked about the
 * primary, whose runtime is spawned before any discovery can run.
 */
export function sessionNameFor(socketPath: string, configRoot: string): string {
  const dir = dirname(socketPath); // <root>  OR  <root>/sessions/<name>
  if (dir === configRoot) return DEFAULT_SESSION_NAME;
  return basename(dir);
}

/** The live per-session pieces a factory builds. push/snooze/notify-prefs/audit stay process-global. */
export interface SessionParts {
  /** The multiplexer this session drives, behind the port. Named for the field the wire has always
   *  had; which multiplexer it is comes from the registry (bridge/mux/registry.ts). */
  herdr: MuxAdapter;
  engine: StateEngine;
  poker: EventPoker;
  notifications: NotificationCoordinator;
}

/** A fully-built, running session runtime: its parts plus its identity in the registry. */
export interface SessionRuntime extends SessionParts {
  name: string;
  isPrimary: boolean;
  socketPath: string;
}

/**
 * Builds (and starts + wires) the runtime for one session. Injected into the registry so the bridge
 * supplies the real mux/StateEngine/EventPoker/NotificationCoordinator wiring while tests can
 * pass fakes. `isPrimary` is threaded so the factory can pick the primary's bare notification tag.
 */
export type SessionFactory = (name: string, socketPath: string, isPrimary: boolean) => SessionParts;

interface SessionRegistryOpts {
  /** The root the primary's endpoint is named against (see {@link sessionNameFor}). */
  configRoot: string;
  /** The primary session's socket (cfg.socketPath) — always present, never disposed. */
  primarySocketPath: string;
  /** Builds a live runtime for a session. */
  factory: SessionFactory;
  /**
   * The OPERATOR's switch (`COLLIE_MULTI_SESSION`). When false, the registry pins to the primary
   * only and refresh() asks nothing.
   *
   * The outer of the two falseable things, and deliberately separate from the inner one: the
   * adapter's `listSessions` declaration says whether this multiplexer has anything to offer, and
   * this says whether the operator wants it. Either one alone pins the registry to the primary.
   */
  multiSession: boolean;
}

/**
 * The wire query key for the session dimension: `session=`. `?s=` is the browser URL spelling
 * (web/src/lib/scope.ts), translated in web/src/lib/api.ts before a request leaves the client.
 */
export const SESSION_PARAM = "session";

/**
 * The wire query key that WIDENS a snapshot to every session on ONE machine, and the ONE value it
 * accepts. `?sessions=all` on the wire; `?all=1` is the browser URL spelling.
 *
 * One exact spelling and nothing else: the parameter is a switch, not a list, so a typo reads as
 * "no" rather than as some third behaviour.
 */
export const SESSIONS_PARAM = "sessions";
export const SESSIONS_ALL = "all";

/**
 * How much of ONE machine a snapshot asks for: which session, and whether to widen to all of them.
 *
 * The pair travels together because it is read together — a widened view of an unknown session is
 * still an unknown session — and because carrying it as one value is what keeps `widen` off every
 * call as a bare boolean. A literal `false` at a call site is how the peer surface came to be
 * permanently narrow (M22/06); a named value has to be built by somebody who knows the request.
 */
export interface SnapshotView {
  /** The session name the request named, or `undefined` for this machine's primary session. */
  readonly session: string | undefined;
  /** Whether every session on this machine contributes its panes. */
  readonly widen: boolean;
}

/** Today's ask, and the one every machine the request did not name gets: primary, unwidened. */
export const NARROW_VIEW: SnapshotView = { session: undefined, widen: false };

/**
 * Read the view off a request URL. The ONE place the two params become one value, so the browser
 * route and the crew surface cannot disagree about what `?sessions=all` means (§5).
 */
export function selectView(url: URL): SnapshotView {
  return {
    session: url.searchParams.get(SESSION_PARAM) ?? undefined,
    widen: url.searchParams.get(SESSIONS_PARAM) === SESSIONS_ALL,
  };
}

/**
 * Flatten several sessions' panes into ONE list, stamping every pane with the session it came from.
 *
 * The two invariants are both in the signature and both matter:
 *
 *  1. EVERY pane is tagged, including the primary session's. The tempting alternative — tag only the
 *     non-primary ones, so "absent means primary" — makes an untagged pane mean two different things
 *     depending on whether the body was widened, and the client deliberately lets an untagged pane
 *     match any scope so that solo lookups stay exactly today's (web/src/lib/hosts.ts `findPane`).
 *     Those two rules together would let a primary pane answer a lookup for a named session's
 *     identically-numbered pane, which is the crew bug one dimension down. All, or none.
 *  2. The CALLER decides the order and this preserves it, because the order is observable: it is the
 *     order rows appear in on a phone, and a list that re-sorts itself under the reader is DESIGN.md
 *     §2. {@link SessionRegistry.ordered} is the order to pass.
 *
 * Generic over the pane shape: this is about addressing, not about what a pane is, and keeping it
 * that way means it can be tested without a wire type.
 */
export function widenedPanes<T extends { session?: string }>(
  sources: readonly { readonly name: string; readonly panes: readonly T[] }[],
): T[] {
  return sources.flatMap(({ name, panes }) => panes.map((p): T => ({ ...p, session: name })));
}

/**
 * Owns the set of live session runtimes. The primary is created eagerly and kept forever; other
 * sessions are the multiplexer's own answer, asked by {@link refresh} and disposed when the
 * multiplexer stops reporting them. Client-facing lookups ({@link get}) are Map lookups by name — a
 * name never becomes a path.
 */
export class SessionRegistry {
  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly factory: SessionFactory;
  private readonly multiSession: boolean;
  private readonly primaryName: string;

  constructor(opts: SessionRegistryOpts) {
    this.factory = opts.factory;
    this.multiSession = opts.multiSession;
    this.primaryName = sessionNameFor(opts.primarySocketPath, opts.configRoot);
    // The primary comes up eagerly — it's the fallback for every session-less request.
    this.runtimes.set(this.primaryName, this.spawn(this.primaryName, opts.primarySocketPath, true));
  }

  /** The primary session's registry name (`"default"` unless HERDR_SOCKET_PATH names a session). */
  get primary(): string {
    return this.primaryName;
  }

  /**
   * Resolve a runtime by name. An absent/empty name selects the primary — so a request with no
   * `?session=` behaves exactly as it did before this feature. An unknown name returns undefined
   * (the caller turns that into a 404); it is never used to construct a path.
   */
  get(name?: string): SessionRuntime | undefined {
    if (!name) return this.runtimes.get(this.primaryName);
    return this.runtimes.get(name);
  }

  /** Every live runtime — used by process-global fan-outs (prefs apply, snooze clear-all). */
  all(): SessionRuntime[] {
    return [...this.runtimes.values()];
  }

  /**
   * Every live runtime in the ONE canonical order: primary first, then alphabetical.
   *
   * {@link all} returns insertion order, which is discovery order — i.e. whichever session's
   * directory the filesystem listed first, and it changes as sessions come and go. That is fine for
   * a fan-out, where order is not observable, and wrong for anything a phone renders: a widened
   * snapshot's pane list would re-order itself under the reader for no reason a reader could see
   * (DESIGN.md §2). This is the order {@link list} already publishes, factored out so the summaries
   * and the panes they describe cannot disagree about it.
   */
  ordered(): SessionRuntime[] {
    return this.all().toSorted((a, b) => {
      if (a.isPrimary) return -1;
      if (b.isPrimary) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  /**
   * Summaries for the snapshot's `sessions` field: primary first, then alphabetical. Counts come
   * from each engine's current snapshot; an unreachable session (last poll failed) reports 0 counts.
   */
  list(): SessionSummary[] {
    return this.ordered().map((rt): SessionSummary => {
      const snap = rt.engine.current();
      const reachable = snap.bridge === "connected";
      const agents = reachable ? snap.agents : [];
      return {
        name: rt.name,
        isPrimary: rt.isPrimary,
        reachable,
        agents: agents.length,
        working: agents.filter((a) => a.status === "working").length,
        blocked: agents.filter((a) => a.status === "blocked").length,
      };
    });
  }

  /**
   * Ask the multiplexer again: start a runtime for any newly-appeared session, dispose one that has
   * gone away. The primary is always retained even if discovery momentarily misses it.
   *
   * Two ways to be a no-op, and they are different facts. The operator's switch off means "do not
   * front more than one" and is checked first. An adapter that answers the contract's `unsupported`
   * means "this multiplexer keeps no such list", and the registry then leaves the primary as the
   * only session, the same outcome, arrived at honestly, and never confused with an EMPTY list,
   * which says "it keeps one and there is nothing else in it right now" and does dispose what went
   * away.
   *
   * Safe to call on a timer, a stale endpoint surfaces as `reachable:false` on its session, never a
   * throw, and the adapter's answer is an outcome rather than an exception by contract.
   */
  async refresh(): Promise<void> {
    if (!this.multiSession) return;
    const primary = this.runtimes.get(this.primaryName);
    if (primary === undefined) return;
    const answer = await primary.herdr.listSessions();
    if (!answer.ok) return;
    const seen = new Set<string>([this.primaryName]);
    for (const { name, endpoint } of answer.value) {
      seen.add(name);
      if (this.runtimes.has(name)) continue;
      this.runtimes.set(name, this.spawn(name, endpoint, false));
    }
    for (const [name, rt] of this.runtimes) {
      if (seen.has(name)) continue; // primaryName is always in `seen` → never disposed
      this.dispose(rt);
      this.runtimes.delete(name);
    }
  }

  /** Stop every runtime (including the primary). For process shutdown only. */
  disposeAll(): void {
    for (const rt of this.runtimes.values()) this.dispose(rt);
    this.runtimes.clear();
  }

  private spawn(name: string, socketPath: string, isPrimary: boolean): SessionRuntime {
    const parts = this.factory(name, socketPath, isPrimary);
    return { name, isPrimary, socketPath, ...parts };
  }

  private dispose(rt: SessionRuntime): void {
    rt.engine.stop();
    rt.poker.stop();
    // Retract anything this session had on the lock screen — its slot must not linger.
    rt.notifications.clearAll();
  }
}

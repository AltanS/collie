import { basename, dirname, join } from "node:path";

import type { EventPoker } from "./event-poker.ts";
import type { HerdrClient } from "./herdr-client.ts";
import type { NotificationCoordinator } from "./notifications.ts";
import type { StateEngine } from "./state-engine.ts";
import type { SessionSummary } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Multi-session support. Herdr can run several named sessions, each its own server
// with its own unix socket:
//   • default session:  <configRoot>/herdr.sock
//   • named session:     <configRoot>/sessions/<name>/herdr.sock
// ONE bridge process fronts N sessions. The primary session (cfg.socketPath) maps to
// all of today's behaviour; everything else is additive and opt-in.
//
// SECURITY: a client-supplied session name is ONLY ever a Map key lookup here — it is
// NEVER used to build a filesystem path. Sockets are discovered from the fs (trusted
// configRoot + a directory listing); the name a browser sends can only select among
// what discovery already found, never reach a path.
// ─────────────────────────────────────────────────────────────────────────────

/** The default session's name — the one whose socket is `<configRoot>/herdr.sock`. */
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
 * The config root that holds a session layout, derived from a socket path. If the socket sits at
 * `…/sessions/<name>/herdr.sock` the root is the prefix before `/sessions/`; otherwise it's just the
 * socket's directory (the default session's `<root>/herdr.sock`). Pure + exported for tests.
 */
export function deriveConfigRoot(socketPath: string): string {
  const dir = dirname(socketPath); // <root>  OR  <root>/sessions/<name>
  const parent = dirname(dir); // <parentOfRoot>  OR  <root>/sessions
  if (basename(parent) === "sessions") return dirname(parent);
  return dir;
}

/**
 * The registry name for a socket, relative to a config root: `"default"` for `<root>/herdr.sock`,
 * else the directory name under `<root>/sessions/`. Pure + exported for tests.
 */
export function sessionNameFor(socketPath: string, configRoot: string): string {
  const dir = dirname(socketPath); // <root>  OR  <root>/sessions/<name>
  if (dir === configRoot) return DEFAULT_SESSION_NAME;
  return basename(dir);
}

/**
 * Discover every running herdr session under a config root: the default (`<root>/herdr.sock`) plus
 * each `<root>/sessions/<name>/herdr.sock` that currently exists. `listSessionDirs` and `exists` are
 * injected (real fs in the bridge, fakes in tests) so this stays pure and unit-testable — and so the
 * only filesystem input is the trusted config root, never a client-supplied name. A cleanly stopped
 * session removes its socket, so a socket's presence is the liveness signal we scan for.
 */
export function discoverSessionSockets(
  configRoot: string,
  listSessionDirs: (dir: string) => string[],
  exists: (p: string) => boolean,
): Array<{ name: string; socketPath: string }> {
  const found: Array<{ name: string; socketPath: string }> = [];
  const defaultSock = join(configRoot, "herdr.sock");
  if (exists(defaultSock)) found.push({ name: DEFAULT_SESSION_NAME, socketPath: defaultSock });
  const sessionsDir = join(configRoot, "sessions");
  for (const name of listSessionDirs(sessionsDir)) {
    const sock = join(sessionsDir, name, "herdr.sock");
    if (exists(sock)) found.push({ name, socketPath: sock });
  }
  return found;
}

/** The live per-session pieces a factory builds. push/snooze/notify-prefs/audit stay process-global. */
export interface SessionParts {
  herdr: HerdrClient;
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
 * supplies the real HerdrClient/StateEngine/EventPoker/NotificationCoordinator wiring while tests can
 * pass fakes. `isPrimary` is threaded so the factory can pick the primary's bare notification tag.
 */
export type SessionFactory = (name: string, socketPath: string, isPrimary: boolean) => SessionParts;

interface SessionRegistryOpts {
  /** The config root that holds the session layout (see {@link deriveConfigRoot}). */
  configRoot: string;
  /** The primary session's socket (cfg.socketPath) — always present, never disposed. */
  primarySocketPath: string;
  /** Builds a live runtime for a session. */
  factory: SessionFactory;
  /** When false, the registry pins to the primary only and refresh() never scans the fs. */
  multiSession: boolean;
  /** Lists the session directory names under `<configRoot>/sessions` (real fs in the bridge). */
  listSessionDirs: (dir: string) => string[];
  /** Whether a path exists (real fs in the bridge). */
  exists: (p: string) => boolean;
}

/**
 * Owns the set of live session runtimes. The primary is created eagerly and kept forever; other
 * sessions are discovered from the filesystem by {@link refresh} and disposed when their socket goes
 * away. Client-facing lookups ({@link get}) are Map lookups by name — a name never becomes a path.
 */
export class SessionRegistry {
  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly configRoot: string;
  private readonly factory: SessionFactory;
  private readonly multiSession: boolean;
  private readonly listSessionDirs: (dir: string) => string[];
  private readonly exists: (p: string) => boolean;
  private readonly primaryName: string;

  constructor(opts: SessionRegistryOpts) {
    this.configRoot = opts.configRoot;
    this.factory = opts.factory;
    this.multiSession = opts.multiSession;
    this.listSessionDirs = opts.listSessionDirs;
    this.exists = opts.exists;
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
   * Summaries for the snapshot's `sessions` field: primary first, then alphabetical. Counts come
   * from each engine's current snapshot; an unreachable session (last poll failed) reports 0 counts.
   */
  list(): SessionSummary[] {
    const summaries = this.all().map((rt): SessionSummary => {
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
    return summaries.sort((a, b) => {
      if (a.isPrimary) return -1;
      if (b.isPrimary) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  /**
   * Rescan the filesystem: start a runtime for any newly-appeared session, dispose one whose socket
   * has gone away. The primary is always retained even if discovery momentarily misses it. A no-op
   * when multi-session is off. Safe to call on a timer — connect failures for a stale socket surface
   * as `reachable:false`, never a throw.
   */
  async refresh(): Promise<void> {
    if (!this.multiSession) return;
    const discovered = discoverSessionSockets(this.configRoot, this.listSessionDirs, this.exists);
    const seen = new Set<string>([this.primaryName]);
    for (const { name, socketPath } of discovered) {
      seen.add(name);
      if (this.runtimes.has(name)) continue;
      this.runtimes.set(name, this.spawn(name, socketPath, false));
    }
    for (const [name, rt] of [...this.runtimes]) {
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

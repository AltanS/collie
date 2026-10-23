// How full a session's context is, and how much of the subscription's windows it has used: the
// numbers the phone draws as dots beside the model tag above the belt (.adr/0115).
//
// ── WHERE THE NUMBERS COME FROM ───────────────────────────────────────────────────────────────────
//
// Claude Code hands its statusLine command a JSON document on every assistant message: the context
// window's `used_percentage`, and for a Pro or Max account the 5-hour and 7-day `rate_limits`. Collie
// holds no model key and reads no credential, so it does not ask the vendor for these. It asks the
// agent: `collie hooks install claude` wraps the operator's OWN statusLine command, and the wrapper
// (`collie beacon statusline`, cli/statusline.ts) writes the three numbers to one small file here
// before it runs the operator's command and passes its output through untouched.
//
// ONE FILE PER SESSION, named by a digest of the harness session id, never by the pane: the pane
// already knows its session (`agentSession`, from Herdr or the beacon), and a session id cannot be
// renumbered under it the way a pane id can. `/clear` starts a new session and therefore a new file;
// the old one ages out ({@link USAGE_MAX_AGE_MS}).
//
// ── WHAT THE BRIDGE TRUSTS ────────────────────────────────────────────────────────────────────────
//
// Numbers only. The record carries no text the phone draws: the window labels are the bridge's own
// (`5h`, `7d`), a percentage is clamped to 0 to 100, and anything else in the file is ignored. A file
// that does not parse, is too large or is from a newer schema is ABSENT, and an absent reading draws
// nothing. A window whose `resetsAt` has passed is dropped, as Claude Code drops it: the number
// belonged to a window that is over.
//
// The reads happen on the state engine's poll (`refresh`), never at serialise time, so the snapshot
// stays synchronous; a file read again only when its mtime moved.

import { createHash } from "node:crypto";
import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { asJsonNumber, asJsonObject, asJsonString, parseJsonObject } from "../web/src/lib/json.ts";
import type { JsonValue } from "./json.ts";
import type { AgentView } from "./types.ts";

/** The directory's name under the state dir, beside `beacons/`. */
export const USAGE_SUBDIR = "usage";

/** Owner-only, as the beacon directory is: anything that can write here can put a number on the phone. */
export const USAGE_DIR_MODE = 0o700;

export const USAGE_SCHEMA_VERSION = 1;

/** A record bigger than this is not one the wrapper wrote. */
export const USAGE_FILE_MAX_BYTES = 4096;

/** A reading older than this is pruned: past the longest window there is, nobody needs it. */
export const USAGE_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;

/** How many files the directory may hold before the oldest go, whatever their age. */
export const USAGE_FILES_MAX = 512;

/** The subscription windows, by the label the phone draws. The bridge's words, never the file's. */
export const USAGE_WINDOWS = ["5h", "7d"] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

/** One subscription window's reading. */
export interface UsageLimit {
  window: UsageWindow;
  /** Percent of the window used, 0 to 100. */
  used: number;
  /** When the window resets, epoch ms. Absent when the harness did not say. */
  resetsAt?: number;
}

/**
 * What the phone draws beside the model: the context use and the subscription windows, each ABSENT
 * when the harness did not report it. A pane whose harness reports nothing carries no `usage` key.
 */
export interface PaneUsage {
  /** Percent of the context window used, 0 to 100. */
  context?: number;
  /** The windows still running, in {@link USAGE_WINDOWS} order. Absent rather than empty. */
  limits?: UsageLimit[];
}

/** The file the wrapper writes: the reading plus when and for which session. */
export interface UsageRecord extends PaneUsage {
  schemaVersion: number;
  harness: string;
  /** Epoch ms of the write. */
  at: number;
}

/** `${stateDir}/usage`. */
export function usageDir(stateDir: string): string {
  return join(stateDir, USAGE_SUBDIR);
}

/**
 * A session id's file name: a digest, so a session id never becomes a path. The id is checked by the
 * writer too, but the digest is what makes a strange id harmless here.
 */
export function usageFileName(session: string): string {
  return `${createHash("sha256").update(session).digest("hex").slice(0, 32)}.json`;
}

/** A percentage as the phone may draw it, or undefined for anything that is not a finite number. */
export function asPercent(value: JsonValue | undefined): number | undefined {
  const n = asJsonNumber(value);
  return n === undefined || !Number.isFinite(n) ? undefined : Math.min(100, Math.max(0, n));
}

function asEpochMs(value: JsonValue | undefined): number | undefined {
  const n = asJsonNumber(value);
  return n !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * The reading in a file's text, or null when it is not one this build reads. Only the numbers are
 * kept, each checked; a window label this build does not draw is dropped.
 */
export function parseUsageRecord(text: string): UsageRecord | null {
  if (text.length > USAGE_FILE_MAX_BYTES) return null;
  const root = parseJsonObject(text);
  if (root === undefined || root.schemaVersion !== USAGE_SCHEMA_VERSION) return null;
  const at = asEpochMs(root.at);
  const harness = asJsonString(root.harness);
  if (at === undefined || harness === undefined) return null;
  const record: UsageRecord = { schemaVersion: USAGE_SCHEMA_VERSION, harness: harness.slice(0, 32), at };
  const context = asPercent(root.context);
  if (context !== undefined) record.context = context;
  const rows = Array.isArray(root.limits) ? root.limits.map(asJsonObject) : [];
  const limits: UsageLimit[] = [];
  for (const window of USAGE_WINDOWS) {
    const entry = rows.find((row) => row !== undefined && asJsonString(row.window) === window);
    const used = asPercent(entry?.used);
    if (entry === undefined || used === undefined) continue;
    const resetsAt = asEpochMs(entry.resetsAt);
    limits.push(resetsAt === undefined ? { window, used } : { window, used, resetsAt });
  }
  if (limits.length > 0) record.limits = limits;
  return record;
}

/**
 * The part of a record the phone gets at `now`: the windows that have not reset yet, and nothing at
 * all when nothing is left.
 */
export function usageAt(record: UsageRecord, now: number): PaneUsage | undefined {
  const usage: PaneUsage = {};
  if (record.context !== undefined) usage.context = record.context;
  const limits = (record.limits ?? []).filter((limit) => limit.resetsAt === undefined || limit.resetsAt > now);
  if (limits.length > 0) usage.limits = limits;
  return usage.context === undefined && usage.limits === undefined ? undefined : usage;
}

/** The disk, as the tracker needs it. A seam, so the rules are testable with no temp files. */
export interface UsageFiles {
  /** The file's mtime in epoch ms, or null when it is not there. */
  mtime(path: string): Promise<number | null>;
  /** The file's text, or null when it cannot be read. */
  read(path: string): Promise<string | null>;
  /** File names directly under the directory, or [] when it is not there. */
  list(dir: string): Promise<string[]>;
  remove(path: string): Promise<void>;
}

/** The real disk. A file over {@link USAGE_FILE_MAX_BYTES} is not read at all. */
export const diskUsageFiles: UsageFiles = {
  mtime: async (path) => {
    try {
      const info = await stat(path);
      return info.isFile() ? info.mtimeMs : null;
    } catch {
      return null;
    }
  },
  read: async (path) => {
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > USAGE_FILE_MAX_BYTES) return null;
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  },
  list: async (dir) => {
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  },
  remove: async (path) => {
    await unlink(path);
  },
};

/** How often the directory is swept for old files. */
const PRUNE_EVERY_MS = 60 * 60 * 1000;

interface Held {
  mtime: number;
  record: UsageRecord | null;
}

/**
 * Each pane's reading, from the files the wrapper writes. `refresh` runs on the state engine's update;
 * `get` is synchronous and reads memory only.
 */
export class UsageTracker {
  private readonly held = new Map<string, Held>();
  /** The session ids each mux session's last poll named, so one session's poll forgets only its own. */
  private readonly scopes = new Map<string, Set<string>>();
  private lastPrune = 0;

  constructor(
    private readonly dir: string,
    private readonly files: UsageFiles,
    private readonly now: () => number = Date.now,
  ) {}

  /** The session id a pane's usage is keyed by, or null for a pane with no id-kind session. */
  private static sessionOf(pane: AgentView): string | null {
    const ref = pane.agentSession;
    return ref !== undefined && ref.kind === "id" && ref.value !== "" ? ref.value : null;
  }

  /**
   * Re-read the files of one mux session's panes whose mtime moved, and forget the sessions no mux
   * session's panes have any more. `scope` is the mux session's name: each one polls on its own.
   */
  async refresh(panes: readonly AgentView[], scope = ""): Promise<void> {
    const sessions = new Set<string>();
    for (const pane of panes) {
      const session = UsageTracker.sessionOf(pane);
      if (session !== null) sessions.add(session);
    }
    this.scopes.set(scope, sessions);
    const alive = new Set<string>();
    for (const ids of this.scopes.values()) for (const id of ids) alive.add(id);
    for (const session of this.held.keys()) if (!alive.has(session)) this.held.delete(session);
    await Promise.all(
      [...sessions].map(async (session) => {
        const path = join(this.dir, usageFileName(session));
        const mtime = await this.files.mtime(path);
        if (mtime === null) {
          this.held.delete(session);
          return;
        }
        if (this.held.get(session)?.mtime === mtime) return;
        const text = await this.files.read(path);
        this.held.set(session, { mtime, record: text === null ? null : parseUsageRecord(text) });
      }),
    );
    await this.prune();
  }

  /** The pane's reading now, or undefined. */
  get(pane: AgentView): PaneUsage | undefined {
    const session = UsageTracker.sessionOf(pane);
    const record = session === null ? null : (this.held.get(session)?.record ?? null);
    return record === null ? undefined : usageAt(record, this.now());
  }

  /** Remove readings past {@link USAGE_MAX_AGE_MS}, then the oldest past {@link USAGE_FILES_MAX}. */
  private async prune(): Promise<void> {
    const now = this.now();
    if (now - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    const names = (await this.files.list(this.dir)).filter((name) => /^[0-9a-f]{32}\.json$/.test(name));
    const dated = await Promise.all(
      names.map(async (name) => ({ path: join(this.dir, name), mtime: await this.files.mtime(join(this.dir, name)) })),
    );
    const live = dated.filter((entry): entry is { path: string; mtime: number } => entry.mtime !== null);
    const stale = live.filter((entry) => now - entry.mtime > USAGE_MAX_AGE_MS);
    const kept = live.filter((entry) => now - entry.mtime <= USAGE_MAX_AGE_MS).toSorted((a, b) => b.mtime - a.mtime);
    for (const entry of [...stale, ...kept.slice(USAGE_FILES_MAX)]) {
      try {
        await this.files.remove(entry.path);
      } catch {
        // A file that will not go is tried again at the next sweep.
      }
    }
  }
}

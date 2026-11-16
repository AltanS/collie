// How full a session's context is, and how much of the subscription's windows it has used: the
// numbers the phone draws as dots beside the model tag above the belt (.adr/0115).
//
// ── WHERE THE NUMBERS COME FROM ───────────────────────────────────────────────────────────────────
//
// Claude Code hands its statusLine command a JSON document on every assistant message: the context
// window's `used_percentage`, and for a Pro or Max account its `rate_limits`. Collie holds no model
// key, so for these numbers it asks the agent and not the vendor: `collie hooks install claude` wraps the operator's OWN statusLine command (by default since
// 2026-11-13), and the wrapper (`collie beacon statusline`, cli/statusline.ts) writes the numbers to
// one small file here before it runs the operator's command and passes its output through untouched.
// Since 2026-10-24 the context number also comes from the session transcript through the beacon hooks
// (`cli/context-reading.ts`), and since 2026-11-13 always against the window size the wrapped
// statusLine stated. With no wrap (none on Windows, none where no statusLine is configured, or the
// operator said `--no-statusline`) nothing states the window, and the session shows its token count.
// The account windows are a separate road. Since 2026-10-24 they come first from the vendor's usage
// endpoint, asked with the login the harness keeps on this machine, read for one request and never
// stored (bridge/account-windows.ts, .adr/0118); a wrapped statusLine is the second road.
//
// OTHER HARNESSES WRITE NO FILE, so since 2026-10-25 their context comes from the journal: the cache
// probe that already reads the session log for the prompt-cache chip also names the tokens the last
// turn carried and, where it can, the model's window (bridge/cache/tracker.ts § context). Codex's log
// names the window itself; pi, Oh My Pi and OpenCode take it from the harness's own model catalog on
// disk (bridge/journal/model-window.ts). No window, no percentage: since 2026-11-13 a model no catalog
// names shows the token count alone (`contextTokens`), as a Claude session with no stated window does.
// A usage file's context, where one exists, wins.
//
// ONE FILE PER SESSION, named by a digest of the harness session id, never by the pane: the pane
// already knows its session (`agentSession`, from Herdr or the beacon), and a session id cannot be
// renumbered under it the way a pane id can. `/clear` starts a new session and therefore a new file;
// the old one ages out ({@link USAGE_MAX_AGE_MS}).
//
// ── WHAT THE BRIDGE TRUSTS ────────────────────────────────────────────────────────────────────────
//
// Numbers only, plus an optional absolute `configDir` that scopes which local Claude credential
// directory `AccountWindows` polls for that session (`configDir` is never sent in `usageAt`). The
// record carries no free text the phone draws: a window's key and label are cleaned and capped, and
// since 2026-11-15 they are the harness's own words (`7d:opus`, `Opus`), not a fixed pair; a percentage is clamped to 0 to 100, and anything else in the file is ignored. A file
// that does not parse, is too large or is from a newer schema is ABSENT, and an absent reading draws
// nothing. A window whose `resetsAt` has passed is dropped, as Claude Code drops it: the number
// belonged to a window that is over.
//
// The reads happen on the state engine's poll (`refresh`), never at serialise time, so the snapshot
// stays synchronous; a file read again only when its mtime moved.

import { createHash } from "node:crypto";
import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { asJsonNumber, asJsonObject, asJsonString, parseJsonObject } from "../web/src/lib/json.ts";
import type { JsonValue } from "./json.ts";
import type { AgentView } from "./types.ts";
import type { UsageSeen } from "./usage-seen.ts";

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

/** The five-hour window's key. Its meaning never changes: an older crew member sends it, and the phone words it. */
export const WINDOW_5H = "5h";
/** The seven-day window's key, as {@link WINDOW_5H}. */
export const WINDOW_7D = "7d";
/** The prefix of a weekly window scoped to a model: `7d:opus`. */
const SCOPED_PREFIX = `${WINDOW_7D}:`;

/** The most windows one reading holds. A strange answer does not fill the tag. */
export const READING_WINDOWS_MAX = 8;
/** The longest window key or label a reading carries. */
const WINDOW_TEXT_MAX = 64;

/**
 * One subscription window's reading. `window` is the harness's own window as an open string (no closed
 * list, since 2026-11-15): `5h` and `7d` keep their meaning, `7d:<scope>` is a weekly window scoped to a
 * model, a length such as `30d` is a window of another length, and `spend` is a gateway spend limit. The
 * field keeps its name because an older crew member sends it and an older phone reads it: that phone
 * skips a key it does not know.
 */
export interface UsageLimit {
  window: string;
  /** Percent of the window used, 0 to 100. */
  used: number;
  /** When the window resets, epoch ms. Absent when the harness did not say. */
  resetsAt?: number;
  /** The harness's own name for a scoped window (`Opus`), cleaned. Absent when it has none. */
  label?: string;
}

/** Text from a reading, made safe to draw: control characters out, trimmed, at most 64 characters. Undefined when nothing is left. */
export function cleanWindowText(text: string): string | undefined {
  // SAFETY: the class is control characters on purpose; text from the wire must not carry them.
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, WINDOW_TEXT_MAX);
  return clean === "" ? undefined : clean;
}

/** A window key as a record may hold it: a non-empty string, cleaned, at most 64 characters. */
export function asWindowKey(value: JsonValue | undefined): string | undefined {
  const text = asJsonString(value);
  return text === undefined ? undefined : cleanWindowText(text);
}

/** The key of a weekly window scoped to the model the vendor names `label`: `7d:` and the label in lower case, spaces as `-`. */
export function scopedWindowKey(label: string): string {
  const scope = label.toLowerCase().replace(/\s+/g, "-");
  return `${SCOPED_PREFIX}${scope}`.slice(0, WINDOW_TEXT_MAX);
}

/** One window's reading, with `resetsAt` and `label` present only when given (an absent key, never `undefined`). */
export function makeLimit(window: string, used: number, resetsAt?: number, label?: string): UsageLimit {
  const limit: UsageLimit = { window, used };
  if (resetsAt !== undefined) limit.resetsAt = resetsAt;
  if (label !== undefined) limit.label = label;
  return limit;
}

/** How a window is sorted: `5h`, then `7d`, then the rest. */
function windowRank(window: string): number {
  return window === WINDOW_5H ? 0 : window === WINDOW_7D ? 1 : 2;
}

/** The name a window sorts by within the rest: its label, else its key. */
function windowName(limit: UsageLimit): string {
  return (limit.label ?? limit.window).toLowerCase();
}

/**
 * A reading's windows in the order they are drawn: `5h`, `7d`, then the rest by label (else key), with a
 * key seen twice kept once (the first) and at most {@link READING_WINDOWS_MAX}.
 */
export function orderedLimits(limits: readonly UsageLimit[]): UsageLimit[] {
  const seen = new Set<string>();
  const unique = limits.filter((limit) => {
    if (seen.has(limit.window)) return false;
    seen.add(limit.window);
    return true;
  });
  return unique
    .toSorted((a, b) => windowRank(a.window) - windowRank(b.window) || windowName(a).localeCompare(windowName(b)) || a.window.localeCompare(b.window))
    .slice(0, READING_WINDOWS_MAX);
}

/**
 * What the phone draws beside the model: the context use and the subscription windows, each ABSENT
 * when the harness did not report it. A pane whose harness reports nothing carries no `usage` key.
 */
export interface PaneUsage {
  /** Percent of the context window used, 0 to 100. Only where the harness stated the window. */
  context?: number;
  /**
   * The tokens in the context: input, cache creation and cache read of the newest request, as the
   * harness counts its own context share. The phone draws it in place of {@link context} when that is
   * absent, because no window was stated to divide by (.adr/0115, amended 2026-11-13). Absent when
   * unknown, never a placeholder.
   */
  contextTokens?: number;
  /** The windows still running, in {@link orderedLimits} order. Absent rather than empty. */
  limits?: UsageLimit[];
  /**
   * The running total of what the session this pane shows has cost, in US dollars (never a count of
   * tokens; Collie prices nothing itself). Claude Code reports it in the statusLine document
   * (`cost.total_cost_usd`); pi, Oh My Pi and OpenCode write it on every assistant message in their
   * logs, and the journal sums those (`CacheProbe.costUsd`); Codex's log carries none. ABSENT, NEVER A
   * PLACEHOLDER: no `0` for "unknown". A usage file's cost wins over the journal's, as the context does.
   */
  cost?: number;
}

/**
 * The file a writer leaves: the reading plus when and for which session. Two writers share it, the
 * statusLine wrapper and the beacon hooks (`cli/usage-store.ts` merges, neither erases the other's
 * fields).
 */
export interface UsageRecord extends PaneUsage {
  schemaVersion: number;
  harness: string;
  /** Epoch ms of the write; with kept `limits`, of the write that reported them. */
  at: number;
  /**
   * The session's context window in tokens, as Claude Code's statusLine document states it
   * (`context_window.context_window_size`), the only window the transcript reading divides by
   * (`cli/context-reading.ts`). A writer's note to the next writer, never drawn: {@link usageAt} leaves
   * it out. Absent when no wrapped statusLine has run, and then the transcript reading writes no context.
   */
  window?: number;
  /**
   * Who gave {@link window}: always {@link WINDOW_BY_STATUSLINE}. Builds before 2026-11-13 also wrote a
   * window from a table of model ids (`opus`, `fable`, `other`) or none at all, and those windows were
   * wrong (a 1M session read against 400k or 200k): {@link parseUsageRecord} drops such a window and the
   * context counted against it. A writer's note, never drawn.
   */
  windowBy?: string;
  /**
   * The non-default `CLAUDE_CONFIG_DIR` this session runs under, as its hooks or statusLine reported.
   * A note for the bridge to align account windows and statusLine limits per account; {@link usageAt}
   * never puts it on the wire.
   */
  configDir?: string;
}

/** The largest window a record may name. A bound on a strange file, not a model's window. */
const WINDOW_MAX = 100_000_000;

/** `windowBy` of a window the statusLine document stated. */
export const WINDOW_BY_STATUSLINE = "statusline";

/** A token count as a record may hold it: a whole number of tokens, zero or more, within the window bound. */
export function asTokenCount(value: JsonValue | undefined): number | undefined {
  const n = asJsonNumber(value);
  return n !== undefined && Number.isInteger(n) && n >= 0 && n <= WINDOW_MAX ? n : undefined;
}

/** A window size as a record may hold it: a whole positive number of tokens within the bound. */
export function asWindowSize(value: JsonValue | undefined): number | undefined {
  const n = asJsonNumber(value);
  return n !== undefined && Number.isInteger(n) && n > 0 && n <= WINDOW_MAX ? n : undefined;
}

function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * `CLAUDE_CONFIG_DIR` exactly as set (not trimmed, not cleaned: Claude Code's Keychain item name hashes
 * the raw string) when it names a valid non-default absolute directory, or undefined when unset, blank,
 * relative, malformed, or pointing at the default `~/.claude`.
 */
export function customClaudeConfigDir(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string | undefined {
  const rawInput = env.CLAUDE_CONFIG_DIR ?? "";
  if (hasControlChar(rawInput)) return undefined;
  if (rawInput.trim() === "" || rawInput.length > 4096 || !isAbsolute(rawInput)) return undefined;
  return join(rawInput, ".") === join(home, ".claude") ? undefined : rawInput;
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

/** The share of a window `tokens` fill, floored to one decimal so a window that is not full never reads as 100. */
export function contextPercent(tokens: number, window: number): number {
  return Math.floor(Math.min(100, (tokens / window) * 100) * 10) / 10;
}

/** A percentage as the phone may draw it, or undefined for anything that is not a finite number. */
export function asPercent(value: JsonValue | undefined): number | undefined {
  const n = asJsonNumber(value);
  return n === undefined || !Number.isFinite(n) ? undefined : Math.min(100, Math.max(0, n));
}

/** A cost as the phone may draw it: a finite number of dollars, zero or more. Anything else is no reading. */
export function asCost(value: JsonValue | undefined): number | undefined {
  const n = asJsonNumber(value);
  return n === undefined || !Number.isFinite(n) || n < 0 ? undefined : n;
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
  // A window the statusLine did not state came from an older build's guess, and so did the context
  // counted against it: neither is kept. A context with no window at all is the statusLine's own percent.
  const guessed = root.window !== undefined && asJsonString(root.windowBy) !== WINDOW_BY_STATUSLINE;
  const context = asPercent(root.context);
  if (context !== undefined && !guessed) record.context = context;
  // The count stands on its own: no window was needed to take it.
  const tokens = asTokenCount(root.contextTokens);
  if (tokens !== undefined) record.contextTokens = tokens;
  const cost = asCost(root.cost);
  if (cost !== undefined) record.cost = cost;
  const size = asWindowSize(root.window);
  if (size !== undefined && !guessed) {
    record.window = size;
    record.windowBy = WINDOW_BY_STATUSLINE;
  }
  const dir = asJsonString(root.configDir);
  if (dir !== undefined && dir.length <= 4096 && !hasControlChar(dir) && isAbsolute(dir)) {
    record.configDir = dir;
  }
  const rows = Array.isArray(root.limits) ? root.limits.map(asJsonObject) : [];
  const limits: UsageLimit[] = [];
  for (const row of rows) {
    const window = asWindowKey(row?.window);
    const used = asPercent(row?.used);
    if (row === undefined || window === undefined || used === undefined) continue;
    const resetsAt = asEpochMs(row.resetsAt);
    const labelText = asJsonString(row.label);
    limits.push(makeLimit(window, used, resetsAt, labelText === undefined ? undefined : cleanWindowText(labelText)));
  }
  const ordered = orderedLimits(limits);
  if (ordered.length > 0) record.limits = ordered;
  return record;
}

/**
 * The part of a record the phone gets at `now`: the windows that have not reset yet, and nothing at
 * all when nothing is left.
 */
export function usageAt(record: UsageRecord, now: number): PaneUsage | undefined {
  const usage: PaneUsage = {};
  if (record.context !== undefined) usage.context = record.context;
  if (record.contextTokens !== undefined) usage.contextTokens = record.contextTokens;
  const limits = (record.limits ?? []).filter((limit) => limit.resetsAt === undefined || limit.resetsAt > now);
  if (limits.length > 0) usage.limits = limits;
  if (record.cost !== undefined) usage.cost = record.cost;
  return hasReading(usage) ? usage : undefined;
}

/** Whether a reading holds anything the phone draws. */
function hasReading(usage: PaneUsage): boolean {
  return usage.context !== undefined || usage.contextTokens !== undefined || usage.limits !== undefined || usage.cost !== undefined;
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

/**
 * The account windows of a harness, from bridge/account-windows.ts: synchronous, memory only, and
 * undefined when there is no fresh reading.
 */
export interface AccountLimits {
  limits(harness: string, configDir?: string): UsageLimit[] | undefined;
  /** Note which custom `configDir`s have live panes in `scope`, so closed profiles stop polling. */
  observeConfigDirs?(harness: string, configDirs: ReadonlySet<string>, scope?: string): void;
}

/**
 * The context the journal read for a session (bridge/cache/tracker.ts): synchronous, memory only,
 * keyed by the pane's `agentSession` value as the cache chip is.
 */
export interface JournalContext {
  context(sessionKey: string): { tokens: number; window?: number } | undefined;
  /** The session's cost in US dollars that the journal summed, or undefined (`CacheTracker.cost`). */
  cost?(sessionKey: string): number | undefined;
}

/** The windows {@link UsageTracker} takes from the held records, and when the newest of those records was written. */
interface NewestLimits {
  limits: UsageLimit[];
  at: number | undefined;
}

/**
 * The folder of the added account a pane runs under (bridge/accounts-routes.ts `folderOf`), cleaned, or
 * undefined for the Default and for a pane that reported a folder no account holds. `scope` is the
 * mux session's name, as the launch note is keyed. A seam, so usage needs no accounts code.
 */
export type PaneAccountFolder = (pane: AgentView, scope: string) => string | undefined;

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
  /** The harnesses each mux session's last refresh named folders for, so a harness whose last pane left is told so. */
  private readonly folderScopes = new Map<string, Set<string>>();
  private lastPrune = 0;

  constructor(
    private readonly dir: string,
    private readonly files: UsageFiles,
    private readonly now: () => number = Date.now,
    private readonly account?: AccountLimits,
    private readonly journal?: JournalContext,
    private readonly seen?: UsageSeen,
    private readonly accountFolder?: PaneAccountFolder,
  ) {}

  /**
   * The config folder a pane runs under: the one its session reported, else the folder of the pane's
   * added account (a pane started with an account whose agent has not reported, or never does).
   * Undefined is the default folder.
   */
  private folderOf(pane: AgentView, record: UsageRecord | null | undefined, scope: string): string | undefined {
    return record?.configDir ?? this.accountFolder?.(pane, scope);
  }

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
    this.observeFolders(panes, scope);
    await this.prune();
  }

  /**
   * Tell the account windows which non-default folders have live panes in `scope`, per harness, so an
   * added account's windows are asked for and a closed one's stop. Every harness with an agent pane
   * here is named, with an empty set when none of its panes runs under another folder, and so is every
   * harness named last time whose panes have all gone: its empty set is what stops a closed folder.
   */
  private observeFolders(panes: readonly AgentView[], scope: string): void {
    const observe = this.account?.observeConfigDirs?.bind(this.account);
    if (observe === undefined) return;
    const byHarness = new Map<string, Set<string>>();
    for (const name of this.folderScopes.get(scope) ?? []) byHarness.set(name, new Set());
    const withPanes = new Set<string>();
    for (const pane of panes) {
      if (pane.kind === "shell") continue;
      const session = UsageTracker.sessionOf(pane);
      const record = session === null ? null : (this.held.get(session)?.record ?? null);
      const harness = pane.agent || record?.harness;
      if (harness === undefined || harness === "") continue;
      withPanes.add(harness);
      const dirs = byHarness.get(harness) ?? new Set<string>();
      byHarness.set(harness, dirs);
      const dir = this.folderOf(pane, record, scope);
      if (dir !== undefined) dirs.add(dir);
    }
    this.folderScopes.set(scope, withPanes);
    for (const [harness, dirs] of byHarness) observe(harness, dirs, scope);
  }

  /**
   * The pane's reading now, or undefined. The context is the pane's own session's. The 5-hour and
   * 7-day windows belong to the ACCOUNT, not the session.
   *
   * When the account windows of the pane's harness are known (bridge/account-windows.ts, ADR 0118),
   * they are the pane's windows, with or without a session record: they are fresher, and they are the
   * account's own. Otherwise each window is the newest one any held session of the same harness
   * reported through a wrapped statusLine: a session that last spoke an hour ago shows what a busier
   * one learned since. On that road only a session that reported windows of its own gets them, so an
   * API-key session beside a subscription one stays without.
   *
   * The context comes from the session's usage file when that holds one (Claude's beacon or wrapped
   * statusLine), else from the journal's reading of the same session when it knows both the tokens
   * and the window (pi, OMP, Codex, OpenCode; .adr/0115 amended 2026-10-25). The cost follows the
   * same rule: the file's (Claude's statusLine), else the journal's sum (pi, OMP, OpenCode).
   */
  get(pane: AgentView, scope = ""): PaneUsage | undefined {
    const session = UsageTracker.sessionOf(pane);
    const record = session === null ? null : (this.held.get(session)?.record ?? null);
    const now = this.now();
    const harness = pane.kind === "shell" ? undefined : pane.agent || record?.harness;
    // The journal fills what the usage file leaves out: the file's own context and cost win.
    const overlay: PaneUsage = record?.context === undefined && record?.contextTokens === undefined ? this.journalContext(pane) : {};
    const journalCost = record?.cost === undefined ? this.journalCost(pane) : undefined;
    if (journalCost !== undefined) overlay.cost = journalCost;
    const configDir = harness === undefined || harness === "" ? record?.configDir : this.folderOf(pane, record, scope);
    const account = harness === undefined || harness === "" ? undefined : this.account?.limits(harness, configDir);
    if (account !== undefined && account.length > 0) {
      const base: UsageRecord = record ?? { schemaVersion: USAGE_SCHEMA_VERSION, harness: harness ?? "", at: now };
      this.seen?.record(base.harness, configDir, account, now);
      return usageAt({ ...base, ...overlay, limits: account }, now);
    }
    if (record === null) return hasReading(overlay) ? overlay : undefined;
    if (record.limits === undefined) return usageAt({ ...record, ...overlay }, now);
    const newest = this.newestLimits(record.harness, now, configDir);
    if (newest.at !== undefined) this.seen?.record(record.harness, configDir, newest.limits, newest.at);
    return usageAt({ ...record, ...overlay, limits: newest.limits }, now);
  }

  /**
   * The pane's context from the journal: a percentage when the log or the catalog named the window,
   * else the token count alone; nothing with no reading or for a shell pane. Keyed by the session
   * ref's value of either kind, as the cache chip is.
   */
  private journalContext(pane: AgentView): PaneUsage {
    if (this.journal === undefined || pane.kind === "shell") return {};
    const key = pane.agentSession?.value;
    if (key === undefined || key === "") return {};
    const reading = this.journal.context(key);
    if (reading === undefined) return {};
    const tokens = asTokenCount(Math.round(reading.tokens));
    const overlay: PaneUsage = tokens === undefined ? {} : { contextTokens: tokens };
    if (reading.window !== undefined && reading.window > 0) overlay.context = contextPercent(reading.tokens, reading.window);
    return overlay;
  }

  /** The pane's session cost from the journal, in dollars, or undefined: none summed, or a shell pane. */
  private journalCost(pane: AgentView): number | undefined {
    if (this.journal?.cost === undefined || pane.kind === "shell") return undefined;
    const key = pane.agentSession?.value;
    if (key === undefined || key === "") return undefined;
    return this.journal.cost(key);
  }

  /**
   * Per window, the limit from the newest held record of `harness` and `configDir` that carries it
   * unexpired, and when the newest of those records was written (undefined with no window).
   */
  private newestLimits(harness: string, now: number, configDir?: string): NewestLimits {
    const newest = new Map<string, { at: number; limit: UsageLimit }>();
    for (const { record } of this.held.values()) {
      if (record === null || record.harness !== harness || record.configDir !== configDir) continue;
      for (const limit of record.limits ?? []) {
        if (limit.resetsAt !== undefined && limit.resetsAt <= now) continue;
        const best = newest.get(limit.window);
        if (best === undefined || record.at > best.at) newest.set(limit.window, { at: record.at, limit });
      }
    }
    const best = [...newest.values()];
    return { limits: orderedLimits(best.map((entry) => entry.limit)), at: best.length === 0 ? undefined : Math.max(...best.map((entry) => entry.at)) };
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

  // ── Accounts (M101): the config folder a session reported, for the account tag and found folders ──

  /**
   * The config folder the pane's session reported, raw: a string for a non-default folder, `null` when
   * the session's record names none (the default), `undefined` when no record is held for it yet.
   */
  reportedConfigDir(pane: AgentView): string | null | undefined {
    const session = UsageTracker.sessionOf(pane);
    const record = session === null ? undefined : this.held.get(session)?.record;
    if (record === undefined || record === null) return undefined;
    return record.configDir ?? null;
  }

  /** Every non-default config folder a held session reported, raw, with its harness. */
  reportedConfigDirs(): { harness: string; dir: string }[] {
    const out: { harness: string; dir: string }[] = [];
    for (const { record } of this.held.values()) {
      if (record?.configDir === undefined) continue;
      if (!out.some((r) => r.harness === record.harness && r.dir === record.configDir)) out.push({ harness: record.harness, dir: record.configDir });
    }
    return out;
  }
}

import { join } from "node:path";

import {
  parseUsageRecord,
  USAGE_DIR_MODE,
  USAGE_FILE_MAX_BYTES,
  USAGE_SCHEMA_VERSION,
  usageDir,
  usageFileName,
  type UsageLimit,
  type UsageRecord,
} from "../bridge/usage.ts";
import { formatTokens } from "../web/src/lib/token-count.ts";
import { privateDir } from "./private-dir.ts";
import type { Files } from "./sys.ts";

// The usage record on disk (.adr/0115). The bridge reads the files (`bridge/usage.ts`); this is the
// only code that puts one there.
//
// ONE FILE, TWO WRITERS. The statusLine wrapper (`cli/statusline.ts`, the default wrap) and the beacon
// hooks (`cli/context-reading.ts`) both write a session's file, and each knows different things: the
// wrapper has the context, the account windows (every `rate_limits` key that holds a `used_percentage`,
// up to eight) and the window size Claude Code states, the
// beacon has the context it reads from the transcript against that stated size. Neither may erase what
// only the other knows, so each writes through a merge
// here: it reads the file that is there, replaces its own fields and keeps the rest.

/** What a writer needs: the disk, and the uid a folder must belong to (absent off POSIX). */
export interface UsageStoreDeps {
  readonly files: Files;
  readonly uid?: number | undefined;
}

/** `<stateDir>/usage/<digest of the session id>.json`, the file the bridge reads for this session. */
export function usagePath(stateDir: string, session: string): string {
  return join(usageDir(stateDir), usageFileName(session));
}

/** The record already in a state dir for this session, or null when there is none or it does not parse. */
export function readUsage(deps: UsageStoreDeps, stateDir: string, session: string): UsageRecord | null {
  const text = deps.files.read(usagePath(stateDir, session));
  return text === null ? null : parseUsageRecord(text);
}

/** The limits of a record that are still running at `now`, as the bridge counts them. */
function liveLimits(record: UsageRecord | null, now: number): UsageLimit[] {
  return (record?.limits ?? []).filter((limit) => limit.resetsAt === undefined || limit.resetsAt > now);
}

/** What the beacon hooks know. `null` removes the context; absent leaves it as it is. */
export interface BeaconChange {
  readonly context?: number | null | undefined;
  /** The context's token count, whatever the window. `null` removes it; absent leaves it as it is. */
  readonly tokens?: number | null | undefined;
  /** The non-default `CLAUDE_CONFIG_DIR` this session runs under. Absent clears any custom dir on file. */
  readonly configDir?: string | undefined;
}

/** Whether two token counts draw the same on the phone (`222k`), so a move inside one step is no write. */
function sameTokensShown(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return formatTokens(a) === formatTokens(b);
}

/**
 * The record the beacon hooks write, or null when the file is already right. The beacon replaces the
 * context (or removes it), and keeps the window the statusLine stated and the running limits it did
 * not report. A record keeps its `at` while it carries kept limits: the bridge picks the newest window
 * across sessions by `at`, and limits are not newer for being carried along. An unchanged whole
 * percent and a token count that draws the same are not a change, so the hot path writes nothing.
 */
export function mergeBeacon(existing: UsageRecord | null, harness: string, now: number, change: BeaconChange): UsageRecord | null {
  const dirChanged = existing !== null && change.configDir !== existing.configDir;
  const limits = dirChanged ? [] : liveLimits(existing, now);
  const record: UsageRecord = {
    schemaVersion: USAGE_SCHEMA_VERSION,
    harness: existing?.harness ?? harness,
    at: existing !== null && limits.length > 0 ? existing.at : now,
  };
  const context = change.context === undefined ? existing?.context : (change.context ?? undefined);
  if (context !== undefined) record.context = context;
  const tokens = change.tokens === undefined ? existing?.contextTokens : (change.tokens ?? undefined);
  if (tokens !== undefined) record.contextTokens = tokens;
  if (existing?.window !== undefined) record.window = existing.window;
  if (existing?.windowBy !== undefined) record.windowBy = existing.windowBy;
  if (change.configDir !== undefined) record.configDir = change.configDir;
  if (limits.length > 0) record.limits = limits;
  // The cost is the wrapper's alone: the beacon keeps what is on file.
  if (existing?.cost !== undefined) record.cost = existing.cost;
  if (
    existing !== null &&
    existing.configDir === record.configDir &&
    (existing.context === undefined ? record.context === undefined : record.context !== undefined && Math.round(existing.context) === Math.round(record.context)) &&
    sameTokensShown(existing.contextTokens, record.contextTokens) &&
    (existing.limits?.length ?? 0) === limits.length
  ) {
    return null;
  }
  return record;
}

/**
 * The record the statusLine wrapper writes: its own context, limits and window size, each kept from
 * the file when this run states none. A reading without a context (early in a session) or without limits (an API-key
 * session) keeps what is on file for that part, as long as it is still running.
 */
export function mergeStatusLine(existing: UsageRecord | null, reading: UsageRecord, now: number): UsageRecord {
  const record: UsageRecord = { schemaVersion: USAGE_SCHEMA_VERSION, harness: reading.harness, at: reading.at };
  const context = reading.context ?? existing?.context;
  if (context !== undefined) record.context = context;
  const tokens = reading.contextTokens ?? existing?.contextTokens;
  if (tokens !== undefined) record.contextTokens = tokens;
  const window = reading.window ?? existing?.window;
  if (window !== undefined) record.window = window;
  // The size this run states; without one, the size an earlier run stated stays.
  const windowBy = reading.window === undefined ? existing?.windowBy : reading.windowBy;
  if (window !== undefined && windowBy !== undefined) record.windowBy = windowBy;
  if (reading.configDir !== undefined) record.configDir = reading.configDir;
  const cost = reading.cost ?? existing?.cost;
  if (cost !== undefined) record.cost = cost;
  if (reading.limits !== undefined) {
    record.limits = reading.limits;
  } else {
    const dirChanged = existing !== null && reading.configDir !== existing.configDir;
    const kept = dirChanged ? [] : liveLimits(existing, now);
    if (kept.length > 0 && existing !== null) {
      record.limits = kept;
      record.at = existing.at;
    }
  }
  return record;
}

/**
 * Write the record to one state dir: a temp name, then a rename, so the bridge never reads half. A
 * folder that is not this user's own and private takes nothing, and neither does a record over the
 * size the bridge reads. A failed write removes its temp file and is silent.
 */
export function writeUsage(deps: UsageStoreDeps, stateDir: string, session: string, record: UsageRecord): void {
  const dir = usageDir(stateDir);
  const text = `${JSON.stringify(record)}\n`;
  if (text.length > USAGE_FILE_MAX_BYTES) return;
  deps.files.mkdirp(dir, USAGE_DIR_MODE);
  if (!privateDir(deps, dir)) return;
  const name = usageFileName(session);
  const temp = join(dir, `.${name}.${process.pid}.tmp`);
  try {
    deps.files.write(temp, text, 0o600);
    deps.files.rename(temp, join(dir, name));
  } catch {
    deps.files.remove(temp);
  }
}

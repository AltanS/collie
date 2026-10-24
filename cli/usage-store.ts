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
import { privateDir } from "./private-dir.ts";
import type { Files } from "./sys.ts";

// The usage record on disk (.adr/0115). The bridge reads the files (`bridge/usage.ts`); this is the
// only code that puts one there.
//
// ONE FILE, TWO WRITERS. The statusLine wrapper (`cli/statusline.ts`, with `--statusline`) and the beacon
// hooks (`cli/context-reading.ts`) both write a session's file, and each knows different things: the
// wrapper has the context and the two subscription windows, the beacon has the context and the
// session's window size. Neither may erase what only the other knows, so each writes through a merge
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
  /** The session's window in tokens. Absent keeps the one on file. */
  readonly window?: number | undefined;
}

/**
 * The record the beacon hooks write, or null when the file is already right. The beacon replaces the
 * context (or removes it), may set the window, and keeps the window and the running limits it did not
 * report. A record keeps its `at` while it carries kept limits: the bridge picks the newest window
 * across sessions by `at`, and limits are not newer for being carried along. An unchanged whole
 * percent is not a change, so the hot path writes nothing.
 */
export function mergeBeacon(existing: UsageRecord | null, harness: string, now: number, change: BeaconChange): UsageRecord | null {
  const limits = liveLimits(existing, now);
  const record: UsageRecord = {
    schemaVersion: USAGE_SCHEMA_VERSION,
    harness: existing?.harness ?? harness,
    at: existing !== null && limits.length > 0 ? existing.at : now,
  };
  const context = change.context === undefined ? existing?.context : (change.context ?? undefined);
  if (context !== undefined) record.context = context;
  const window = change.window ?? existing?.window;
  if (window !== undefined) record.window = window;
  if (limits.length > 0) record.limits = limits;
  if (
    existing !== null &&
    existing.window === record.window &&
    (existing.context === undefined ? record.context === undefined : record.context !== undefined && Math.round(existing.context) === Math.round(record.context)) &&
    (existing.limits?.length ?? 0) === limits.length
  ) {
    return null;
  }
  return record;
}

/**
 * The record the statusLine wrapper writes: its own context and limits, with the window the beacon
 * noted kept. A reading without a context (early in a session) or without limits (an API-key
 * session) keeps what is on file for that part, as long as it is still running.
 */
export function mergeStatusLine(existing: UsageRecord | null, reading: UsageRecord, now: number): UsageRecord {
  const record: UsageRecord = { schemaVersion: USAGE_SCHEMA_VERSION, harness: reading.harness, at: reading.at };
  const context = reading.context ?? existing?.context;
  if (context !== undefined) record.context = context;
  const window = reading.window ?? existing?.window;
  if (window !== undefined) record.window = window;
  if (reading.limits !== undefined) {
    record.limits = reading.limits;
  } else {
    const kept = liveLimits(existing, now);
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

import { readFileSync } from "node:fs";
import { join } from "node:path";

// THE STAGING PROGRESS FILE: `<state dir>/update-staging-<run id>.log` (M20/10).
//
// ── WHY IT EXISTS ────────────────────────────────────────────────────────────
// The longest window of an update is the fetch and the build, and until this file it was the one
// window with nothing on the wire at all. `handOff` (`cli/update.ts`) writes the first run record
// AFTER staging finishes, so on a slow machine the phone showed "Starting…" for a minute and then
// "Still starting. The host has not reported the run yet." — two sentences over the part of the run
// that actually takes the time.
//
// ── WHY THE SHAPE LIVES IN `bridge/` ─────────────────────────────────────────
// `bridge/update-run.ts`'s argument, unchanged: the writer is `cli/`, the reader is the bridge,
// `cli/` may import from `bridge/` and nothing in `bridge/` may import from `cli/`. So the path, the
// bound and the read live here. One definition, never two that agree today.
//
// ── WHY A FILE AND NOT A JOURNAL ─────────────────────────────────────────────
// The detached launch has three tiers (`bridge/update-action.ts`): `systemd-run --user --collect`,
// then `setsid`, then a bare spawn. Only the first has a journal, its unit name carries a stamp that
// is recorded nowhere, and `--collect` takes the unit away when it exits. A path derived from the
// state directory is the one answer that is the same on all three, and it does not depend on the
// launcher at all — the staging process writes it itself, before any launcher is involved.

/** How many lines of staging output the bridge keeps. Bounded here, so the file cannot grow. */
export const STAGING_LOG_LINES = 40;

/** How much of one line survives. A build can print a very long path; the phone renders a card. */
export const STAGING_LOG_LINE_CHARS = 300;

/**
 * `<state dir>/update-staging-<run id>.log`.
 *
 * KEYED TO THE RUN, which is what makes a stale file unreadable as the current one: a reader asks
 * for the run it is looking at, so last week's file is simply a path nobody requests. A single fixed
 * name would have needed a timestamp check, and a timestamp check is a rule that can be wrong.
 */
export const stagingLogPath = (stateDir: string, runId: string): string =>
  join(stateDir, `update-staging-${safeRunId(runId)}.log`);

/** The prefix every such file shares — how a writer finds the previous run's file to remove it. */
export const STAGING_LOG_PREFIX = "update-staging-";

/**
 * A run id, reduced to what may appear in a file name.
 *
 * Run ids are `crypto.randomUUID()` today, so this changes nothing — but the id reaches here from a
 * `--run-id` argument, and a value that could contain `/` or `..` is a value that could name a path
 * outside the state directory. It is closed here rather than trusted at each call.
 */
export function safeRunId(runId: string): string {
  const cleaned = runId.replace(/[^A-Za-z0-9._-]/g, "");
  return cleaned === "" ? "unknown" : cleaned.slice(0, 64);
}

/**
 * The tail of this run's staging output, or null when there is none to read.
 *
 * WHOLE LINES ONLY. The writer appends line by line while this reads, so the last line on disk may
 * be half written; it is dropped unless the file ends in a newline. A tail that showed half a
 * sentence would be a tail the operator reads as a crash.
 */
export function readStagingLog(stateDir: string, runId: string): string | null {
  let text: string;
  try {
    text = readFileSync(stagingLogPath(stateDir, runId), "utf8");
  } catch {
    return null;
  }
  return tailOf(text);
}

/** The whole-line tail of `text`, bounded, or null when there is not one whole line in it. */
export function tailOf(text: string): string | null {
  const end = text.lastIndexOf("\n");
  if (end < 0) return null;
  const whole = text.slice(0, end);
  const lines = whole
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => (line.length > STAGING_LOG_LINE_CHARS ? `${line.slice(0, STAGING_LOG_LINE_CHARS)}…` : line));
  if (lines.length === 0) return null;
  return lines.slice(-STAGING_LOG_LINES).join("\n");
}

// The files a process holds open, asked of `lsof`, for the discoverers that find a session through a
// file its process keeps open (dsh's `session.lock`, grok's `chat_history.jsonl`, agy's `presence/<uuid>.lock`). One reader, so the
// fork, its limits and its cache are written once.
//
// WHAT IS ASKED: `lsof -nP -p PID -g PID -Fn`. Without `-a` lsof ORs its selectors, so this is the
// UNION of the files of the process and of every process in the group that PID leads. That is meant:
// dsh-tui keeps a session lock in a child worker, and a foreground pid that leads its group owns that
// group's children. A pid that does not lead a group matches nothing for `-g`, so the second selector
// adds nothing then. `-a` would AND the two and drop the children, which is the case it is for. The
// pid is a validated integer from the multiplexer, never client input, and `execFile` runs no shell.
// agy asks the pid alone, `lsof -nP -a -p PID -Fn` (scope `"pid"`), as it did with its own reader.
//
// A PER-PID ANSWER IS KEPT FOR A SECOND. For these harnesses the
// multiplexer never reports a session, so discovery runs on every chat, history, changes and files
// request, and each run would fork `lsof` (up to its timeout). The cache holds the PROMISE, so two
// requests in one tick share one fork, and it holds a failed run too (as no files): a missing or
// slow `lsof` is asked again after a second, not on every request. At most {@link MAX_CACHED_PIDS}
// pids are kept; the table is cleared whole when it is full.
//
// FAIL CLOSED: an `lsof` that will not run, times out or is not installed answers no files, which is
// what discovery already treats as "nothing found". Windows has no `lsof` and answers the same.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** How long one pid's answer is reused. */
export const OPEN_FILES_TTL_MS = 1000;
/** The most pids one reader keeps an answer for. */
export const MAX_CACHED_PIDS = 64;
/** The most pids discovery may ask about in one run, as kiro-discovery.ts bounds its hint processes. */
export const MAX_OPEN_FILES_PIDS = 64;

/** The runner seam: `lsof`'s raw `-Fn` output for one pid. Tests inject their own. */
export type LsofRunner = (args: readonly string[]) => Promise<string>;

/** The paths `pid` holds open, as the `n` lines of `lsof -Fn` name them. */
export type OpenFiles = (pid: number) => Promise<readonly string[]>;

const exec = promisify(execFile);

/** The real `lsof`: a fixed binary name, an argv array, a 1 s limit and a 1 MiB buffer. */
export const runLsof: LsofRunner = async (args) =>
  (
    await exec("lsof", [...args], {
      timeout: 1000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    })
  ).stdout;

/**
 * What one question covers: `"group"` is the pid's files and its group's (see the header), what dsh,
 * grok and mcode ask; `"pid"` is the pid's own files only (`-a -p PID`), what agy asks, as it did with
 * its own reader before it shared this one.
 */
export type LsofScope = "group" | "pid";

/** The argument list for one pid in `scope`. */
export function lsofArgs(pid: number, scope: LsofScope = "group"): readonly string[] {
  if (scope === "pid") return ["-nP", "-a", "-p", String(pid), "-Fn"];
  return ["-nP", "-p", String(pid), "-g", String(pid), "-Fn"];
}

/** The paths in `lsof -Fn` output: every `n` line, without its tag. */
export function pathsOf(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split("\n")) if (line.startsWith("n")) paths.push(line.slice(1));
  return paths;
}

/**
 * A reader with its own cache. The runner and the clock are seams for tests; the default is the real
 * `lsof`. `scope` picks the question, the pid's group by default; one reader asks one scope only, so
 * its cache never answers one scope with the other's files.
 */
export function createOpenFiles(
  run: LsofRunner = runLsof,
  now: () => number = Date.now,
  { scope = "group" }: { scope?: LsofScope } = {},
): OpenFiles {
  const cache = new Map<number, { at: number; paths: Promise<readonly string[]> }>();
  return (pid) => {
    const kept = cache.get(pid);
    if (kept !== undefined && now() - kept.at <= OPEN_FILES_TTL_MS) return kept.paths;
    const paths = run(lsofArgs(pid, scope)).then(pathsOf, (): readonly string[] => []);
    if (cache.size >= MAX_CACHED_PIDS) cache.clear();
    cache.set(pid, { at: now(), paths });
    return paths;
  };
}

/** The reader the product uses for a pid and its group. One cache for dsh, grok and mcode: the same pid asks the same question. */
export const openFiles: OpenFiles = createOpenFiles();

/** The reader for a pid's own files only, agy's: its presence lock is held by the agy process itself. */
export const pidOpenFiles: OpenFiles = createOpenFiles(runLsof, Date.now, { scope: "pid" });

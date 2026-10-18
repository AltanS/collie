// Kiro discovery: the session a pane's foreground Kiro TUI owns, for a pane that names no session.
//
// Several Kiro sessions can share one cwd and one set of workspace folders (two tabs in one
// project), so neither cwd nor the newest session says which one a pane shows. Discovery needs the
// pane's foreground process list and refuses without it; there is no folder fallback.
//
// Observed on kiro-cli 2.32.0: the V3 TUI holds <bucket>/<id>/.lock, {pid, started_at},
// for the session it shows. The lock moves on /clear, /rewind and a /sessions switch, and its
// started_at is when it was taken, not when the process started. A switch holds both locks for
// tens of milliseconds; discovery refuses that overlap. A sub-agent holds no lock of its own.
//
// What has to agree before a session is returned:
//  - exactly one foreground process looks like the Kiro TUI, by its argv;
//  - the OS (the injected probe) says that pid is alive now with the same argv shape;
//  - exactly one lock under the roots names that pid, taken after the process started, in a scan
//    that saw every session folder;
//  - the source's own resolve lands on that very log;
//  - the lock and the process are unchanged when checked again after resolve.

import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { JsonObject, JsonValue } from "../json.ts";
import { asRecord } from "./cache-probe.ts";
import { containedRealpath, readSmallFile } from "./files.ts";
import { isKiroSessionId, KIRO_LOG_NAME } from "./kiro-sessions.ts";
import type { AgentSessionRef, DiscoverHints, ProcessIdentity, ProcessIdentityProbe, TranscriptSource } from "./types.ts";

const MAX_PID = 4194304;
const MAX_HINT_PROCESSES = 64;
const MAX_LOCK_BYTES = 4096;
const CLOCK_MARGIN_MS = 2000;
/** Folder entries one lock scan may list, across every root and bucket. A scan cut short finds nothing. */
const MAX_SCAN_ENTRIES = 8192;

interface Lock {
  pid: number;
  startedAt: number;
}

/** A session folder whose lock names the pane's TUI, with the root it was found under. */
interface Candidate {
  readonly id: string;
  readonly path: string;
  readonly root: string;
  readonly lock: Lock;
}

function validPid(pid: number | undefined): pid is number {
  return pid !== undefined && Number.isSafeInteger(pid) && pid > 0 && pid <= MAX_PID;
}

// Bun flags whose next word is code to run, so that word is not the script.
const BUN_CODE_FLAGS = new Set(["-e", "--eval", "-p", "--print"]);

function kiroArgv(argv: readonly string[]): boolean {
  if (argv.length === 0 || argv.length > 256 || argv.some((arg) => arg.length > 4096)) return false;
  // The TUI runs as `<data>/kiro-cli/bun --no-env-file <data>/kiro-cli/tui.js chat ...`. The
  // kiro-cli and kiro-cli-chat processes above it share its process group but do not own the lock.
  // Only the script Bun runs counts, never a later argument that happens to mention Kiro.
  if (basename(argv[0] ?? "") !== "bun") return false;
  const at = argv.findIndex((arg, index) => index > 0 && !arg.startsWith("-"));
  if (at < 0 || at > 32 || argv.slice(1, at).some((flag) => BUN_CODE_FLAGS.has(flag))) return false;
  return /(?:^|[/\\])kiro-cli[/\\]tui\.js$/.test(argv[at] ?? "");
}

/** The lock in a session folder under `root`, or null when there is none or it is not a lock. */
async function readLock(session: string, root: string): Promise<Lock | null> {
  const path = await containedRealpath(join(session, ".lock"), root);
  if (path === null) return null;
  const content = await readSmallFile(path, MAX_LOCK_BYTES);
  if (content === null) return null;
  let raw: JsonObject | null;
  try {
    // SAFETY: JSON.parse returns JSON values; asRecord checks the object boundary.
    raw = asRecord(JSON.parse(content) as JsonValue);
  } catch {
    return null;
  }
  const pid = raw?.pid;
  if (raw === null || typeof pid !== "number" || !validPid(pid)) return null;
  const started = raw.started_at;
  if (typeof started !== "string") return null;
  const ms = Date.parse(started);
  // The lock's time is an ISO 8601 UTC string with milliseconds; anything Date.parse reads loosely
  // (a bare number, an impossible date it rolls over) is refused rather than guessed at.
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== started) return null;
  return { pid, startedAt: ms };
}

/** The lock was taken while this process was alive: not before it started, not in the future. */
function current(lock: Lock, process: ProcessIdentity): boolean {
  return Number.isFinite(process.startedAt) && lock.startedAt >= process.startedAt - CLOCK_MARGIN_MS &&
    lock.startedAt <= process.observedAt + CLOCK_MARGIN_MS;
}

/** The OS's answer for `pid`, kept only when its current argv is still the Kiro TUI's. */
async function liveTui(processes: ProcessIdentityProbe, pid: number): Promise<ProcessIdentity | null> {
  const found = await processes.identify(pid).catch(() => null);
  // The pane's argv came from the multiplexer's last look. A pid reused since then has other argv.
  return found !== null && kiroArgv(found.argv) ? found : null;
}

/**
 * The one session whose lock `pid` holds, or null when there is none, several, or the scan reached
 * its entry limit. Every session is scanned, never only a --resume-id in the TUI's argv: the argv
 * keeps the session it started with after a /sessions switch moves the lock.
 */
async function onlyLockOf(roots: readonly string[], pid: number, live: ProcessIdentity): Promise<Candidate | null> {
  let left = MAX_SCAN_ENTRIES;
  let found: Candidate | null = null;
  for (const root of roots) {
    for (const bucket of await readdir(root).catch(() => [])) {
      const sessions = await readdir(join(root, bucket)).catch(() => []);
      left -= 1 + sessions.length;
      if (left < 0) return null;
      for (const id of sessions) {
        if (!isKiroSessionId(id)) continue;
        const path = join(root, bucket, id);
        const lock = await readLock(path, root);
        if (lock?.pid !== pid || !current(lock, live)) continue;
        if (found !== null) return null;
        found = { id, path, root, lock };
      }
    }
  }
  return found;
}

/**
 * Discovery for one Kiro journal: it scans `roots`, the source's own, and checks its answer through
 * the source's resolve. `processes` is how the OS is asked about a pid (bridge/proc-identity.ts on Linux).
 */
export function createKiroDiscovery(
  roots: readonly string[],
  source: TranscriptSource,
  processes: ProcessIdentityProbe,
): (cwd: string, hints?: DiscoverHints) => Promise<AgentSessionRef | null> {
  return async (_cwd, hints): Promise<AgentSessionRef | null> => {
    const listed = hints?.processes;
    if (listed === undefined || listed.length > MAX_HINT_PROCESSES) return null;
    const owners = new Set<number>();
    for (const process of listed) {
      if (validPid(process.pid) && kiroArgv(process.argv)) owners.add(process.pid);
    }
    // More than one foreground Kiro is not proof of which one owns this pane.
    if (owners.size !== 1) return null;
    const [pid] = owners;
    if (pid === undefined) return null;
    const live = await liveTui(processes, pid);
    if (live === null) return null;
    try {
      const candidate = await onlyLockOf(roots, pid, live);
      if (candidate === null) return null;
      const ref: AgentSessionRef = { kind: "id", value: candidate.id };
      // The same ID in another bucket or root must not resolve to some other transcript
      // through the source's cache or its root order.
      const log = await containedRealpath(join(candidate.path, KIRO_LOG_NAME), candidate.root);
      if (log === null || (await source.resolve(ref)) !== log) return null;
      const again = await readLock(candidate.path, candidate.root);
      const alive = await liveTui(processes, pid);
      if (again === null || alive === null || alive.token !== live.token || again.pid !== pid ||
          again.startedAt !== candidate.lock.startedAt || !current(again, alive)) return null;
      return ref;
    } catch {
      return null;
    }
  };
}

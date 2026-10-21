// Kiro discovery: the session a pane's foreground Kiro TUI owns, for a pane that names no session.
//
// Several Kiro sessions can share one cwd and one set of workspace folders (two tabs in one
// project), so neither cwd nor the newest session says which one a pane shows. Discovery needs the
// pane's foreground process list and refuses without it; there is no folder fallback.
//
// Observed on kiro-cli 2.32.0: the V3 TUI holds <bucket>/<id>/.lock, {pid, started_at}, for the
// session it shows. The lock moves on /clear, /rewind and a /sessions switch. A switch holds both
// locks for tens of milliseconds; discovery refuses that overlap. A sub-agent holds no lock.
//
// What has to agree before a session is returned:
//  - exactly one foreground process is the Kiro TUI, by its argv. The multiplexer reads that list
//    for each request (Herdr asks the OS every time), so it is as fresh as the request;
//  - exactly one lock under the roots names that pid, in a scan that saw every session folder;
//  - the source's own resolve lands on that very log.
// A Kiro that crashed leaves its lock behind. If a later process in the pane gets the same pid, this
// would show it the crashed session; pids are reused rarely enough that discovery accepts that.

import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { JsonValue } from "../json.ts";
import { asRecord } from "./cache-probe.ts";
import { containedRealpath } from "./files.ts";
import { isKiroSessionId, KIRO_LOG_NAME } from "./kiro-sessions.ts";
import type { AgentSessionRef, DiscoverHints, TranscriptSource } from "./types.ts";

const MAX_PID = 4194304;
const MAX_HINT_PROCESSES = 64;
const MAX_LOCK_BYTES = 4096;
/** Folder entries one lock scan may list, across every root and bucket. A scan cut short finds nothing. */
const MAX_SCAN_ENTRIES = 8192;

/** A session folder whose lock names the pane's TUI, with the root it was found under. */
interface Candidate {
  readonly id: string;
  readonly path: string;
  readonly root: string;
}

function validPid(pid: number | undefined): pid is number {
  return pid !== undefined && Number.isSafeInteger(pid) && pid > 0 && pid <= MAX_PID;
}

// Bun flags whose next word is code to run, so that word is not the script.
const BUN_CODE_FLAGS = new Set(["-e", "--eval", "-p", "--print"]);

function kiroArgv(argv: readonly string[]): boolean {
  // The TUI runs as `<data>/kiro-cli/bun --no-env-file <data>/kiro-cli/tui.js chat ...`. The
  // kiro-cli and kiro-cli-chat processes above it share its process group but do not own the lock.
  // Only the script Bun runs counts, never a later argument that happens to mention Kiro.
  if (basename(argv[0] ?? "") !== "bun") return false;
  const at = argv.findIndex((arg, index) => index > 0 && !arg.startsWith("-"));
  if (at < 0 || argv.slice(1, at).some((flag) => BUN_CODE_FLAGS.has(flag))) return false;
  return /(?:^|[/\\])kiro-cli[/\\]tui\.js$/.test(argv[at] ?? "");
}

/** The pid the lock in a session folder under `root` names, or null when there is no such lock. */
async function lockPid(session: string, root: string): Promise<number | null> {
  const path = await containedRealpath(join(session, ".lock"), root);
  if (path === null) return null;
  const size = await stat(path).then((st) => (st.isFile() ? st.size : null), () => null);
  if (size === null || size > MAX_LOCK_BYTES) return null;
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return null;
  try {
    // SAFETY: JSON.parse returns JSON values; asRecord checks the object boundary.
    const pid = asRecord(JSON.parse(text) as JsonValue)?.pid;
    return typeof pid === "number" && validPid(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * The one session whose lock `pid` holds, or null when there is none, several, or the scan reached
 * its entry limit. Every session is scanned, never only a --resume-id in the TUI's argv: the argv
 * keeps the session it started with after a /sessions switch moves the lock.
 */
async function onlyLockOf(roots: readonly string[], pid: number): Promise<Candidate | null> {
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
        if ((await lockPid(path, root)) !== pid) continue;
        if (found !== null) return null;
        found = { id, path, root };
      }
    }
  }
  return found;
}

/** Discovery for one Kiro journal: it scans `roots`, the source's own, and checks its answer through the source's resolve. */
export function createKiroDiscovery(
  roots: readonly string[],
  source: TranscriptSource,
): (cwd: string, hints?: DiscoverHints) => Promise<AgentSessionRef | null> {
  return async (_cwd, hints): Promise<AgentSessionRef | null> => {
    const listed = hints?.processes;
    if (listed === undefined || listed.length > MAX_HINT_PROCESSES) return null;
    const owners = new Set<number>();
    for (const process of listed) {
      if (validPid(process.pid) && kiroArgv(process.argv)) owners.add(process.pid);
    }
    // More than one foreground Kiro is not proof of which one owns this pane.
    const [pid] = owners;
    if (owners.size !== 1 || pid === undefined) return null;
    const candidate = await onlyLockOf(roots, pid);
    if (candidate === null) return null;
    const ref: AgentSessionRef = { kind: "id", value: candidate.id };
    // The same ID in another bucket or root must not resolve to some other transcript.
    const log = await containedRealpath(join(candidate.path, KIRO_LOG_NAME), candidate.root);
    return log !== null && (await source.resolve(ref)) === log ? ref : null;
  };
}

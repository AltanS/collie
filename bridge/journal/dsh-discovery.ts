// dsh discovery: the session a pane's foreground dsh process is writing, for a pane that names none.
//
// dsh-tui reports its state to Herdr through a custom source, and Herdr keeps a session only from
// its own integrations, so a dsh-tui pane never carries a ref. Several dsh sessions can share one
// cwd (two tabs in one project), so neither the folder nor the newest session says which one a
// pane shows. What does: dsh's session writer holds a kernel lock, flock(2) on the session folder's
// `session.lock`, for exactly as long as it owns that session, and nothing else ever opens that
// file ("readers never touch the lock"). The lock file is EMPTY, so unlike Kiro's it names no pid;
// the kernel is the only place that says who holds it.
//
// What has to agree before a session is returned:
//  - the kernel lists a FLOCK write lock held by a foreground process of the pane;
//  - that lock's device and inode are those of a `session.lock` found by walking the configured
//    roots (bounded, as kiro-discovery.ts bounds its scan; a scan cut short finds nothing);
//  - among the sessions that pid holds, exactly one is a top-level session (a sub-agent is a child
//    session, written by the same process, and its header says so with `delegationDepth > 0`);
//  - the source's own resolve lands on that session's log.
//
// WHY THE LOCK TABLE AND NOT THE PROCESS'S OPEN FILES. /proc/<pid>/fd would name the lock file
// directly, but reading it is a ptrace check, and Ubuntu's default Yama setting (ptrace_scope 1)
// grants it only to the process's ancestors. dsh runs under Herdr and the bridge under its own
// service, so the bridge is refused (EACCES). /proc/locks is readable by everyone and names the pid,
// the device and the inode of every lock, which is enough once the lock files are known.
//
// LINUX ONLY: the lock table is read from /proc. Elsewhere the reader answers null and discovery
// finds nothing, which is the safe answer: the pane keeps its terminal view.

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { HOST } from "../host.ts";
import type { JsonValue } from "../json.ts";
import { asRecord } from "./cache-probe.ts";
import { DSH_LOCK_NAME, isDshSessionId, newestLog, scanFrames } from "./dsh-sessions.ts";
import { containedRealpath, MAX_FRAME_OUTPUT_BYTES } from "./files.ts";
import type { AgentSessionRef, DiscoverHints, TranscriptSource } from "./types.ts";

const MAX_PID = 4194304;
const MAX_HINT_PROCESSES = 64;
/** Folder entries one lock scan may list, across every root and project. A scan cut short finds nothing. */
const MAX_SCAN_ENTRIES = 8192;
/** The most of a log's head read to find its header row. The header is the first, small frame. */
const HEADER_BYTES = 64 * 1024;

/** The kernel fact discovery reads, as a seam so tests need no live process. */
export interface ProcReader {
  /** The files `pid` holds a FLOCK write lock on, as `<major>:<minor>:<inode>`, or null when the table cannot be read. */
  flocks(pid: number): Promise<Set<string> | null>;
}

/** The real /proc. Off Linux every answer is null. */
export const LINUX_PROC: ProcReader = {
  async flocks(pid) {
    if (HOST.platform !== "linux") return null;
    const table = await readFile("/proc/locks", "utf8").catch(() => null);
    return table === null ? null : flocksOf(table, pid);
  },
};

/**
 * The files `pid` holds a FLOCK write lock on, from the text of /proc/locks, as
 * `<major>:<minor>:<inode>` in decimal. A row reads
 * `<n>: FLOCK  ADVISORY  WRITE <pid> <maj>:<min>:<inode> <start> <end>`, the device numbers in hex; a
 * blocked waiter's row starts `<n>: -> `, and is not a holder.
 */
export function flocksOf(table: string, pid: number): Set<string> {
  const held = new Set<string>();
  for (const row of table.split("\n")) {
    const fields = row.trim().split(/\s+/);
    if (fields[1] !== "FLOCK" || fields[3] !== "WRITE" || Number(fields[4]) !== pid) continue;
    const [major, minor, inode] = (fields[5] ?? "").split(":");
    if (!/^[0-9a-f]+$/i.test(major ?? "") || !/^[0-9a-f]+$/i.test(minor ?? "") || !/^\d+$/.test(inode ?? "")) continue;
    held.add(`${Number.parseInt(major ?? "", 16)}:${Number.parseInt(minor ?? "", 16)}:${inode}`);
  }
  return held;
}

/** A file's identity in the lock table's terms, `<major>:<minor>:<inode>`, from Linux's dev_t encoding. */
export function fileKey(dev: bigint, ino: bigint): string {
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn);
  const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn);
  return `${major}:${minor}:${ino}`;
}

function validPid(pid: number | undefined): pid is number {
  return pid !== undefined && Number.isSafeInteger(pid) && pid > 0 && pid <= MAX_PID;
}

/**
 * Whether the session in `folder` is a top-level one, from its header row. A sub-agent's session
 * says `delegationDepth > 0`. A header that cannot be read counts as top-level: the depth is only
 * ever used to set a sub-agent aside, never to accept a session on its own.
 */
async function topLevel(folder: string): Promise<boolean> {
  const log = await newestLog(folder);
  if (log === null) return true;
  const bytes = await Bun.file(log).slice(0, HEADER_BYTES).bytes().catch(() => null);
  if (bytes === null) return true;
  let first: string;
  if (log.endsWith(".zstd")) {
    const frame = scanFrames(bytes)?.frames[0];
    if (frame === undefined) return true;
    try {
      first = new TextDecoder().decode(zstdDecompressSync(bytes.subarray(frame.start, frame.end), { maxOutputLength: MAX_FRAME_OUTPUT_BYTES }));
    } catch {
      return true;
    }
  } else {
    first = new TextDecoder().decode(bytes);
  }
  try {
    // SAFETY: JSON.parse returns JSON values; asRecord checks the object boundary.
    const depth = asRecord(JSON.parse(first.split("\n", 1)[0] ?? "") as JsonValue)?.delegationDepth;
    return typeof depth !== "number" || depth <= 0;
  } catch {
    return true;
  }
}

/** A session folder whose lock a pane's process holds, with the root it was found under. */
interface Held {
  readonly id: string;
  readonly folder: string;
  readonly root: string;
}

/**
 * The session folders under `roots` whose `session.lock` is one of `locked`, or null when the walk
 * reached its entry limit. Every session folder is visited; only a lock file's stat is read.
 */
async function lockedSessions(roots: readonly string[], locked: ReadonlySet<string>): Promise<Held[] | null> {
  let left = MAX_SCAN_ENTRIES;
  const held: Held[] = [];
  for (const root of roots) {
    for (const project of await readdir(root).catch(() => [])) {
      const sessions = await readdir(join(root, project)).catch(() => []);
      left -= 1 + sessions.length;
      if (left < 0) return null;
      for (const id of sessions) {
        if (!isDshSessionId(id)) continue;
        const folder = join(root, project, id);
        const st = await stat(join(folder, DSH_LOCK_NAME), { bigint: true }).catch(() => null);
        if (st === null || !st.isFile() || !locked.has(fileKey(st.dev, st.ino))) continue;
        if ((await containedRealpath(folder, root)) !== null) held.push({ id, folder, root });
      }
    }
  }
  return held;
}

/** Discovery for one dsh journal: it reads `roots`, the source's own, and checks its answer through the source's resolve. */
export function createDshDiscovery(
  roots: readonly string[],
  source: TranscriptSource,
  proc: ProcReader = LINUX_PROC,
): (cwd: string, hints?: DiscoverHints) => Promise<AgentSessionRef | null> {
  return async (_cwd, hints): Promise<AgentSessionRef | null> => {
    const listed = hints?.processes;
    if (listed === undefined || listed.length > MAX_HINT_PROCESSES) return null;
    const locked = new Set<string>();
    for (const pid of new Set(listed.map((p) => p.pid).filter(validPid))) {
      const held = await proc.flocks(pid);
      if (held === null) return null;
      for (const key of held) locked.add(key);
    }
    if (locked.size === 0) return null;
    const found = await lockedSessions(roots, locked);
    if (found === null) return null;
    const top: Held[] = [];
    for (const session of found) {
      if (await topLevel(session.folder)) top.push(session);
    }
    // Two top-level sessions in one foreground is not proof of which one this pane shows.
    const [only] = top;
    if (top.length !== 1 || only === undefined) return null;
    const ref: AgentSessionRef = { kind: "id", value: only.id };
    // The same ID under another project folder or root must not resolve to some other transcript.
    const log = await source.resolve(ref);
    return log !== null && dirname(log) === (await containedRealpath(only.folder, only.root)) ? ref : null;
  };
}

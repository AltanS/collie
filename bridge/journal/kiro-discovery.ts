// The V3 TUI holds <bucket>/<id>/.lock for the session it shows; workflow and child
// runs hold no parent lock. The lock records {pid, started_at} from when it was taken,
// not from process start. During a session switch both locks can be held for a moment.
// Refuse that overlap.
// Never use cwd or the newest session as identity, and never read V2 cli/*.lock.

import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { parseProcStartTime, parseProcState, procStatPath } from "../beacon/liveness.ts";
import { HOST } from "../host.ts";
import { containedRealpath, rootList } from "./files.ts";
import type { AgentSessionRef, DiscoverHints, TranscriptSource } from "./types.ts";

/** A V3 sessions-root bucket: a workspace-set hash, or `_global`. */
export const KIRO_BUCKET = /^(?:[0-9a-f]{16}|_global)$/;
// Session IDs are not always sess_<uuid>: an overridden or imported session keeps its own ID.
const SESSION = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_PID = 4194304;
const MAX_ROOTS = 32;
const MAX_ENTRIES = 8192;
const MAX_LOCK_BYTES = 4096;
const CLOCK_MARGIN_MS = 2000;

/** Current OS process identity. The token changes when a PID is reused. */
export interface KiroProcessIdentity {
  token: string;
  startedAt: number;
}

/** Clock and live-process inspection, injectable without launching test processes. */
export interface KiroDiscoveryRuntime {
  now(): number;
  inspect(pid: number): Promise<KiroProcessIdentity | null>;
}

interface Lock {
  pid: number;
  startedAt: number;
}

interface Candidate {
  root: string;
  directory: string;
  id: string;
  lock: Lock;
}

function validPid(pid: number | undefined): pid is number {
  return pid !== undefined && Number.isSafeInteger(pid) && pid > 0 && pid <= MAX_PID;
}

function kiroArgv(argv: readonly string[]): boolean {
  if (argv.length === 0 || argv.length > 256 || argv.some((arg) => arg.length > 4096)) return false;
  const command = basename(argv[0] ?? "");
  // kiro-cli wrappers share the TUI's process group but do not own its session lock.
  // A generic Bun/Node process is not a Kiro hint. Only its actual script counts,
  // never a later argument that happens to mention Kiro.
  if (!["bun", "node"].includes(command)) return false;
  let index = 1;
  while (index < Math.min(argv.length, 32)) {
    const arg = argv[index] ?? "";
    if (["--no-env-file", "--no-warnings", "run"].includes(arg) || arg.startsWith("--config=")) { index++; continue; }
    if (arg === "--config") { index += 2; continue; }
    if (arg === "--") index++;
    break;
  }
  return /(?:^|[/\\])kiro-cli[/\\]tui\.js$/.test(argv[index] ?? "");
}

/** A V3 session directory name; `workflows` holds workflow sessions, not a parent log. */
export function isKiroSessionId(id: string): boolean {
  return SESSION.test(id) && id.trim() === id && id.toLowerCase() !== "workflows";
}

async function boundedRead(path: string, limit: number): Promise<string | null> {
  // NOFOLLOW prevents a swapped final symlink; NONBLOCK prevents a swapped FIFO
  // from hanging the bridge before descriptor type validation can run.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (file === null) return null;
  try {
    if (!(await file.stat()).isFile()) return null;
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    return length > limit ? null : bytes.subarray(0, length).toString("utf8");
  } finally {
    await file.close();
  }
}

async function inspectProcess(pid: number): Promise<KiroProcessIdentity | null> {
  if (!validPid(pid)) return null;
  try { process.kill(pid, 0); } catch { return null; }
  // Native session references still work elsewhere. Process discovery needs the
  // verified start-time and current-argv checks below; liveness alone cannot
  // distinguish a reused PID from the session's original owner.
  if (HOST.platform !== "linux") return null;
  // Linux x64/arm64 expose /proc starttime in USER_HZ (100), not kernel HZ.
  // Fail closed on other architectures rather than guessing their clock units.
  if (!["x64", "arm64"].includes(process.arch)) return null;
  const before = await boundedRead(procStatPath(pid), 4096);
  const command = await boundedRead(`/proc/${pid}/cmdline`, 4096);
  const uptime = await boundedRead("/proc/uptime", 128);
  const after = await boundedRead(procStatPath(pid), 4096);
  if (before === null || after === null || command === null || uptime === null || !kiroArgv(command.split("\0").filter((arg) => arg !== ""))) return null;
  const ticks = parseProcStartTime(before);
  const seconds = Number(uptime.split(" ")[0]);
  if (parseProcState(before) === "Z" || parseProcState(after) === "Z" || ticks === null || ticks !== parseProcStartTime(after) || !Number.isSafeInteger(ticks) || ticks <= 0 || !Number.isFinite(seconds) || seconds <= 0 || ticks / 100 > seconds) return null;
  return { token: `${pid}:${ticks}`, startedAt: Date.now() - seconds * 1000 + ticks * 10 };
}

const runtime: KiroDiscoveryRuntime = { now: Date.now, inspect: inspectProcess };

async function directory(path: string, root: string): Promise<boolean> {
  const stamp = await lstat(path).catch(() => null);
  return stamp?.isDirectory() === true && !stamp.isSymbolicLink() && await containedRealpath(path, root) === path;
}

async function regular(path: string, root: string): Promise<boolean> {
  const stamp = await lstat(path).catch(() => null);
  return stamp?.isFile() === true && !stamp.isSymbolicLink() && await containedRealpath(path, root) === path;
}

async function readLock(session: string, root: string): Promise<Lock | null> {
  const path = join(session, ".lock");
  // Most saved sessions have no owner. Probe the small sidecar before paying
  // for descendant validation; no read happens until every path passes it.
  const stamp = await lstat(path).catch(() => null);
  if (stamp?.isFile() !== true || stamp.isSymbolicLink() || stamp.size > MAX_LOCK_BYTES) return null;
  if (!await directory(root, root) || !await directory(join(session, ".."), root) || !await directory(session, root) || await containedRealpath(path, root) !== path) return null;
  const content = await boundedRead(path, MAX_LOCK_BYTES);
  if (content === null) return null;
  try {
    // SAFETY: only these primitive fields are consumed, after JSON shape checks.
    const raw = JSON.parse(content) as { pid?: number; started_at?: string; startedAt?: string } | null;
    if (raw === null || Array.isArray(raw) || !validPid(raw.pid)) return null;
    const started = raw.started_at ?? raw.startedAt;
    if (typeof started !== "string" || (raw.started_at !== undefined && raw.startedAt !== undefined && raw.started_at !== raw.startedAt)) return null;
    const ms = Date.parse(started);
    // The TUI writer uses toISOString(). Invalid/normalized dates and loose
    // numeric/date strings are not lock timestamps. Earlier TUIs used camelCase.
    if (!Number.isFinite(ms) || new Date(ms).toISOString() !== started) return null;
    return { pid: raw.pid, startedAt: ms };
  } catch { return null; }
}

function current(lock: Lock, identity: KiroProcessIdentity, now: number): boolean {
  const oldest = identity.startedAt;
  return Number.isFinite(oldest) && lock.startedAt >= oldest - CLOCK_MARGIN_MS && lock.startedAt <= now + CLOCK_MARGIN_MS;
}

/** Discover one exact foreground TUI's V3 session; the normal source still validates its ID. */
export function createKiroDiscovery(
  roots: readonly string[],
  source: TranscriptSource,
  environment: KiroDiscoveryRuntime = runtime,
): (cwd: string, hints?: DiscoverHints) => Promise<AgentSessionRef | null> {
  const configured = rootList(roots).filter(isAbsolute);
  return async (_cwd, hints): Promise<AgentSessionRef | null> => {
    const processes = hints?.processes;
    if (processes === undefined || processes.length > 64 || configured.length > MAX_ROOTS) return null;
    const owners = new Set<number>();
    for (const process of processes) {
      if (validPid(process.pid) && kiroArgv(process.argv)) owners.add(process.pid);
    }
    // More than one foreground Kiro is not proof of which one owns this pane.
    if (owners.size !== 1) return null;
    const [pid] = owners;
    if (pid === undefined) return null;
    const live = await environment.inspect(pid).catch(() => null);
    if (live === null) return null;
    let candidate: Candidate | null = null;
    let visited = 0;
    try {
      for (const root of configured) {
        const realRoot = await containedRealpath(root, root);
        if (realRoot === null) continue;
        // Configured roots may have a trusted symlink in their ancestry (for
        // example ~/.kiro relocated by the operator). Anchor the walk to the
        // canonical root, but still refuse a root that is itself a symlink.
        const stamp = await lstat(root).catch(() => null);
        if (stamp?.isDirectory() !== true || stamp.isSymbolicLink() || !await directory(realRoot, realRoot)) return null;
        const buckets = await opendir(realRoot);
        for await (const bucket of buckets) {
          if (++visited > MAX_ENTRIES) return null;
          if (!bucket.isDirectory() || bucket.isSymbolicLink() || !KIRO_BUCKET.test(bucket.name) || bucket.name.trim() !== bucket.name) continue;
          const bucketPath = join(realRoot, bucket.name);
          if (!await directory(bucketPath, realRoot)) return null;
          // Scan every session, never only the startup --resume-id: that argv
          // survives /resume, and transfers briefly own two locks.
          for await (const session of await opendir(bucketPath)) {
            if (++visited > MAX_ENTRIES) return null;
            const id = session.name;
            if (!session.isDirectory() || session.isSymbolicLink() || !isKiroSessionId(id)) continue;
            const sessionDir = join(bucketPath, id);
            const lock = await readLock(sessionDir, realRoot);
            if (lock?.pid !== pid || !current(lock, live, environment.now())) continue;
            if (candidate !== null) return null;
            candidate = { root: realRoot, directory: sessionDir, id, lock };
          }
        }
      }
      if (candidate === null) return null;
      const ref: AgentSessionRef = { kind: "id", value: candidate.id };
      const log = join(candidate.directory, "messages.jsonl");
      if (!await regular(join(candidate.directory, "session.json"), candidate.root) || !await regular(log, candidate.root)) return null;
      // An ID duplicated in another bucket/root must not resolve to some other
      // transcript through the source's cache or first-root preference.
      const resolved = await source.resolve(ref);
      if (resolved === null || await containedRealpath(resolved, candidate.root) !== log) return null;
      const again = await readLock(candidate.directory, candidate.root);
      const alive = await environment.inspect(pid);
      if (again === null || alive === null || alive.token !== live.token || again.pid !== pid || again.startedAt !== candidate.lock.startedAt || !current(again, alive, environment.now())) return null;
      return ref;
    } catch {
      // An incomplete walk cannot establish uniqueness, even if a match was seen.
      return null;
    }
  };
}

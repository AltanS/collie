/**
 * When a process started, in epoch milliseconds (M79 spec 06).
 *
 * A pi or Oh My Pi pane writes no session log before its first reply, so a fresh pane in a folder
 * with an older log would be handed that older conversation. The adapter compares the log's start to
 * the harness process start, and this module answers the second half. It is best effort: any
 * platform without a source, and any read that fails, answers `null`, and the caller then behaves
 * as if it knew nothing.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { HOST, type Host } from "../host.ts";

const exec = promisify(execFile);

/**
 * Clock ticks per second in `/proc/<pid>/stat`. That unit is USER_HZ, which the Linux ABI fixes at
 * 100 on every architecture Collie runs on, so no `getconf` fork is needed.
 */
const CLK_TCK = 100;

/** How long one pid's answer is kept, so a poll does not fork `ps` or read `/proc` on every pass. */
const CACHE_MS = 60_000;

/** Most pids kept; a long-lived bridge never grows the table past this. */
const CACHE_MAX = 256;

/**
 * Field 22 of `/proc/<pid>/stat` (start time in clock ticks since boot), or null. The second field
 * is the command name in parentheses and may hold spaces and parentheses itself, so the fields are
 * counted from after the LAST closing parenthesis, where field 3 (the state) comes first.
 */
export function parseProcStat(stat: string): number | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/u);
  const ticks = Number(fields[19]);
  return Number.isInteger(ticks) && ticks >= 0 ? ticks : null;
}

/** The `btime` line of `/proc/stat` (boot time, epoch seconds), or null. */
export function parseBtime(procStat: string): number | null {
  const seconds = /^btime\s+(\d+)\s*$/mu.exec(procStat)?.[1];
  if (seconds === undefined) return null;
  const value = Number(seconds);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** The start in epoch milliseconds from the two `/proc` texts, or null. */
export function linuxStartMs(stat: string, procStat: string): number | null {
  const ticks = parseProcStat(stat);
  const btime = parseBtime(procStat);
  if (ticks === null || btime === null) return null;
  return btime * 1000 + Math.round((ticks * 1000) / CLK_TCK);
}

/**
 * `ps -o etime=` output (`[[dd-]hh:]mm:ss`) as elapsed milliseconds, or null.
 * `05:07` is 5 min 7 s, `1:02:03` is 1 h 2 min 3 s, `2-03:04:05` is 2 days 3 h 4 min 5 s.
 */
export function parseEtime(etime: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/u.exec(etime.trim());
  if (match === null) return null;
  const [, days, hours, minutes, seconds] = match;
  const total =
    Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
  return Number.isSafeInteger(total) ? total * 1000 : null;
}

async function readStart(pid: number, now: number, host: Host = HOST): Promise<number | null> {
  try {
    if (host.platform === "linux") {
      const [stat, procStat] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile("/proc/stat", "utf8")]);
      return linuxStartMs(stat, procStat);
    }
    if (host.platform === "darwin") {
      const { stdout } = await exec("ps", ["-o", "etime=", "-p", String(pid)], { timeout: 2000 });
      const elapsed = parseEtime(stdout);
      return elapsed === null ? null : now - elapsed;
    }
    return null;
  } catch {
    return null;
  }
}

const cache = new Map<number, { at: number; startMs: number | null }>();

/** The start of process `pid` in epoch ms, or null when it cannot be read (gone, no source, Windows). */
export async function processStartMs(pid: number): Promise<number | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const now = Date.now();
  const hit = cache.get(pid);
  if (hit !== undefined && now - hit.at < CACHE_MS) return hit.startMs;
  const startMs = await readStart(pid, now);
  if (cache.size >= CACHE_MAX) {
    for (const [key, value] of cache) {
      if (now - value.at >= CACHE_MS) cache.delete(key);
    }
    if (cache.size >= CACHE_MAX) cache.clear();
  }
  cache.set(pid, { at: now, startMs });
  return startMs;
}

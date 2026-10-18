// The journal's process probe on Linux: what runs under a pid now, read from `/proc`.
//
// A journal adapter that matches a pane to a session through the process holding it (Kiro's lock,
// journal/kiro-discovery.ts) asks this seam ({@link ProcessIdentityProbe}) instead of the
// multiplexer's last look. A stat line is parsed by bridge/beacon/liveness.ts, the parser the
// beacon's pid probe uses, so the two cannot disagree about a process's start time. It reads and
// never writes.

import type { Host } from "./host.ts";
import { readSmallFile } from "./journal/files.ts";
import type { ProcessIdentityProbe } from "./journal/types.ts";
import { parseProcStartTime, procStatPath } from "./beacon/liveness.ts";

/** The most bytes read from one /proc file. A longer stat line or argv is refused, never cut. */
const PROC_READ_MAX = 4096;

/** The first number of `/proc/uptime`, seconds since boot, or null when it is not a positive number. */
function uptimeSeconds(text: string): number | null {
  const raw = text.trim().split(/\s+/u)[0] ?? "";
  if (!/^\d+(?:\.\d+)?$/u.test(raw)) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * The journal's process probe, on Linux: a pid's current argv and a start-time token.
 *
 * It answers only for a live process this user may signal, and only on Linux x64 and
 * arm64, where `/proc` start times count USER_HZ (100 per second). Other architectures may count in
 * other units, so the probe answers null there rather than guess, and so does every other platform.
 * A null answer makes Kiro discovery find nothing; a session the pane names still opens.
 *
 * The stat line is read before and after argv. A different start time between the two reads means
 * the pid was reused while the probe ran, so the argv may belong to another process.
 */
export function procProcessIdentity(host: Host, arch: string, now: () => number): ProcessIdentityProbe {
  return {
    async identify(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0) return null;
      if (host.platform !== "linux" || (arch !== "x64" && arch !== "arm64")) return null;
      try {
        process.kill(pid, 0);
      } catch {
        // EPERM counts as no process too, unlike grok's processAlive: a session's owner is the
        // user's own TUI, so a pid this user may not signal cannot be one.
        return null;
      }
      const before = await readSmallFile(procStatPath(pid), PROC_READ_MAX);
      const cmdline = await readSmallFile(`/proc/${pid}/cmdline`, PROC_READ_MAX);
      const uptime = await readSmallFile("/proc/uptime", PROC_READ_MAX);
      const after = await readSmallFile(procStatPath(pid), PROC_READ_MAX);
      if (before === null || after === null || cmdline === null || uptime === null) return null;
      const ticks = parseProcStartTime(before);
      const seconds = uptimeSeconds(uptime);
      if (ticks === null || ticks <= 0 || ticks !== parseProcStartTime(after)) return null;
      if (seconds === null || ticks / 100 > seconds) return null;
      const observedAt = now();
      return {
        token: `${pid}:${ticks}`,
        startedAt: observedAt - seconds * 1000 + ticks * 10,
        observedAt,
        // A zombie's cmdline is empty, so it answers with no argv and matches no agent.
        argv: cmdline.split("\0").filter((arg) => arg !== ""),
      };
    },
  };
}

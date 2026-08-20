// THE BEACON SEAMS, IN THEIR REAL IMPLEMENTATIONS — the filesystem half that `bridge/beacon/` refuses
// to hold.
//
// Everything under `bridge/beacon/` is pure by rule: the directory, the pid probe and "are the hooks
// installed" are seams it declares and never fills, which is what lets the reader, the parser and the
// decorator run under `bun test` with no temp files and no live process. This module is where those
// three are filled, and it sits OUTSIDE that directory so the rule stays greppable rather than
// remembered.
//
// It reads and it never writes. Nothing here can cause a send, a key, a rename or a close — a beacon
// is a hint, never a control channel (.adr/0024).

import { readFileSync } from "node:fs";
import { readdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";

import { parseProcStartTime, procStatPath } from "./beacon/liveness.ts";
import { beaconsDir, BEACON_FILE_SUFFIX } from "./beacon/paths.ts";
import type { BeaconDirectory, BeaconLiveness, BeaconSweepDeps } from "./beacon/reader.ts";
import type { JsonValue } from "./json.ts";
import type { Environment } from "../cli/context.ts";
import { claudeSettingsTargets, markedCommandIn } from "../cli/hooks.ts";

/**
 * The beacon directory on disk.
 *
 * EVERY FAILURE IS THE SAME FAILURE: an absent directory, an unreadable file, a file that vanished
 * mid-sweep, something that is not a regular file — each answers `null`, which the reader already
 * reads as "there is no beacon here". A beacon directory that cannot be listed must never be able to
 * take the herd view down.
 */
export function fileBeaconDirectory(stateDir: string): BeaconDirectory {
  const dir = beaconsDir(stateDir);
  return {
    async list(): Promise<readonly string[] | null> {
      try {
        const names = await readdir(dir);
        return names.filter((name) => name.endsWith(BEACON_FILE_SUFFIX));
      } catch {
        return null;
      }
    },
    async read(name: string): Promise<string | null> {
      // The name comes from our own listing and is checked against the key grammar by the reader, but
      // it is joined here rather than anywhere else — nothing outside this module ever supplies one,
      // and no client ever supplies one at all.
      const path = join(dir, name);
      try {
        // `lstat`, not `stat`: a symlink in the beacon directory is somebody redirecting a read, and
        // the honest answer to it is the same as to an absent file. Nothing is followed.
        const stats = await lstat(path);
        if (!stats.isFile()) return null;
        return await readFile(path, "utf8");
      } catch {
        return null;
      }
    },
  };
}

/**
 * The pid probe, on Linux.
 *
 * The unit is `bridge/beacon/liveness.ts`'s and must stay that module's, because the EMITTER stores
 * what the same parser returned: two implementations that agree today are not that guarantee, and a
 * mismatch would make every live beacon read expired in silence.
 */
export function procBeaconLiveness(): BeaconLiveness {
  return {
    startTimeOf(pid: number): Promise<number | null> {
      try {
        return Promise.resolve(parseProcStartTime(readFileSync(procStatPath(pid), "utf8")));
      } catch {
        // No such process, or a platform with no `/proc`. Both mean the same thing to the reader: it
        // cannot confirm the writer is alive, so the beacon is expired rather than live.
        return Promise.resolve(null);
      }
    },
  };
}

/** Everything a real sweep needs. The clock and the TTL stay the reader's defaults. */
export function beaconReader(stateDir: string): BeaconSweepDeps {
  return { directory: fileBeaconDirectory(stateDir), liveness: procBeaconLiveness() };
}

// ── Are the emitter's hooks installed? ────────────────────────────────────────

/**
 * How long an answer is reused before the settings files are read again.
 *
 * The declaration is read per request (`muxConfigBody`), so this cannot be a read per call. It is
 * also not a value that may be cached for the life of the process: `collie hooks install claude` is
 * something an operator runs while the service is up, and a capability that only appeared after a
 * restart would send them looking for a restart verb that this change does not need. A few seconds is
 * the same bargain `operator-file.ts` strikes for `commands.toml`.
 */
export const HOOKS_PROBE_TTL_MS = 5000;

/** What the probe needs to find the settings files. The bridge's own home and environment. */
export interface HooksProbeDeps {
  readonly home: string;
  readonly env: Environment;
  /** Injected so a test can pin the cache's clock; production leaves it. */
  readonly now?: () => number;
  /** The seam the real files arrive through — one string per path, `null` for absent/unreadable. */
  readFile?(path: string): string | null;
}

/**
 * One settings file's own answer: does it carry an entry Collie owns?
 *
 * The ownership marker is `cli/hooks.ts`'s, read through `cli/hooks.ts`'s own function, and that
 * import direction is deliberate. The install verb and this probe must agree on what "installed"
 * means down to the marker string; a copy of the check over here would be a second definition, and
 * the failure it produced — a capability declared over beacons nobody writes — is exactly the kind
 * that shows up only on somebody's real host.
 */
export function documentCarriesOurHooks(text: string): boolean {
  let decoded: JsonValue;
  try {
    decoded = JSON.parse(text);
  } catch {
    // A settings file we cannot read is one `collie hooks install claude` refuses to merge into, so
    // nothing of ours is in it.
    return false;
  }
  if (!(decoded instanceof Object) || Array.isArray(decoded)) return false;
  const section = decoded.hooks;
  if (!(section instanceof Object) || Array.isArray(section)) return false;
  for (const groups of Object.values(section)) {
    if (!Array.isArray(groups)) continue;
    if (groups.some((group) => markedCommandIn(group) !== null)) return true;
  }
  return false;
}

/**
 * "Is the emitter installed for at least one harness?", cached.
 *
 * AT LEAST ONE is the right bar for the decorator's lift: the capability says a pane MAY name its
 * agent, not that every pane will. An operator with hooks in one profile and not another gets sight
 * in the profile they installed it in and the honest "no beacon ⇒ unknown" everywhere else, which is
 * exactly what the join already does per pane.
 */
export function hooksInstalledProbe(deps: HooksProbeDeps): () => boolean {
  const clock = deps.now ?? Date.now;
  const read = deps.readFile ?? readTextFile;
  let answer = false;
  let checkedAt = Number.NEGATIVE_INFINITY;
  return (): boolean => {
    const now = clock();
    if (now - checkedAt < HOOKS_PROBE_TTL_MS) return answer;
    checkedAt = now;
    answer = claudeSettingsTargets({ home: deps.home, env: deps.env }).some((target) => {
      const text = read(target.path);
      return text !== null && documentCarriesOurHooks(text);
    });
    return answer;
  };
}

/** One file's text, or null for every reason a file may not be readable. */
function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

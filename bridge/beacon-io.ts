// THE BEACON SEAMS, IN THEIR REAL IMPLEMENTATIONS — the filesystem half that `bridge/beacon/` refuses
// to hold.
//
// Everything under `bridge/beacon/` is pure by rule: the directory, the pid probe and "are the hooks
// installed" are seams it declares and never fills, which is what lets the reader, the parser and the
// decorator run under `bun test` with no temp files and no live process. This module is where those
// three are filled, and it sits OUTSIDE that directory so the rule stays greppable rather than
// remembered.
//
// It reads and it never writes, with two exceptions (M56 spec 11): the edge spool deletes each edge
// file it took, so an edge is taken once, and a bridge that takes edges writes its own hook target
// file at boot and removes it on a clean stop. Nothing here can cause a send, a key, a rename or a close: a
// beacon and an edge are hints, never a control channel (.adr/0024).

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile, lstat, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { HOOK_TARGET_SCHEMA_VERSION, hookTargetFileName, hookTargetsDir, identityFields, parseHookTarget, type HookTargetEnv, type HookTargetIdentity } from "./beacon/hook-targets.ts";

import { parseProcStartTime, procStatPath } from "./beacon/liveness.ts";
import { parseEdge } from "./beacon/parse.ts";
import type { SavedSource, SourceStore } from "./surface/edges.ts";
import { asJsonNumber, asJsonObject, asJsonString, parseJson } from "../web/src/lib/json.ts";
import { beaconsDir, BEACON_FILE_SUFFIX, EDGE_FILE, edgesDir } from "./beacon/paths.ts";
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

// ── The edge spool (M56 spec 11) ──────────────────────────────────────────────

/** The edge spool seam: every edge file's text, each taken once (read, then deleted). */
export interface EdgeSpool {
  take(): Promise<readonly string[]>;
}

/** The most edge files one take reads. The emitter caps the spool at the same order of size. */
const EDGE_TAKE_MAX = 512;

/**
 * The edge spool on disk: `<stateDir>/edges/`. Names that are not edge files (a temp file mid-write,
 * anything foreign) are left alone. A symlink or a non-file is deleted unread. Every failure is
 * "nothing to take": the screen still reads every pane on its own poll.
 */
export function fileEdgeSpool(stateDir: string, uid: number | undefined = process.getuid?.()): EdgeSpool {
  const dir = edgesDir(stateDir);
  return {
    async take(): Promise<readonly string[]> {
      let names: string[];
      try {
        names = (await readdir(dir)).filter((name) => EDGE_FILE.test(name)).toSorted().slice(0, EDGE_TAKE_MAX);
      } catch {
        return [];
      }
      const texts: string[] = [];
      for (const name of names) {
        const path = join(dir, name);
        try {
          const stats = await lstat(path);
          // A file another user wrote is not an edge of this user's agents: deleted unread.
          if (stats.isFile() && (uid === undefined || stats.uid === uid)) texts.push(await readFile(path, "utf8"));
        } catch {
          // Gone between the listing and the read: another take had it.
        }
        await rm(path, { force: true }).catch(() => undefined);
      }
      return texts;
    },
  };
}

// ── The hook target registry (M56 spec 11, bridge/beacon/hook-targets.ts) ─────

/** This bridge's entry in the hook target registry. */
export interface HookTargetRegistration {
  /**
   * Writes the file again when it is missing or names another pid. An emitter can delete it between
   * reading a dead pid and this bridge's restart on the same state dir; the liveness tick heals that.
   */
  keep(): void;
  /** For a clean stop: deletes the file only while it still names this process. */
  remove(): void;
}

/**
 * Writes this bridge's hook target file, so every emitter on the host also writes its edges here.
 * A newer bridge on the same state dir keeps its own file on this one's stop. A write that fails is
 * one warning until a later write works: the emitter then falls back to the default state dir, as
 * before the registry.
 */
export function registerHookTarget(
  stateDir: string,
  env: HookTargetEnv = process.env,
  home: string = homedir(),
  identity: HookTargetIdentity = {},
): HookTargetRegistration {
  const dir = hookTargetsDir(env, home);
  const path = join(dir, hookTargetFileName(stateDir));
  let pidStartTime: number | null = null;
  try {
    pidStartTime = parseProcStartTime(readFileSync(procStatPath(process.pid), "utf8"));
  } catch {
    // No /proc: the emitter checks the pid alone.
  }
  // The wire form, not a HookTargetRecord: the identity fields are written only when the caller knows them.
  const record = { schemaVersion: HOOK_TARGET_SCHEMA_VERSION, stateDir, pid: process.pid, pidStartTime, bootedAt: Date.now(), ...identityFields(identity) };
  const temp = join(dir, `.${String(process.pid)}.tmp`);
  let warned = false;
  const write = (): void => {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      renameSync(temp, path);
      warned = false;
    } catch (err) {
      rmSync(temp, { force: true });
      if (!warned) console.warn(`[surface] could not register as a hook target in ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      warned = true;
    }
  };
  const ownPid = (): boolean => {
    try {
      return parseHookTarget(readFileSync(path, "utf8"))?.pid === process.pid;
    } catch {
      return false;
    }
  };
  write();
  return {
    keep: () => {
      if (!ownPid()) write();
    },
    remove: () => {
      if (ownPid()) rmSync(path, { force: true });
    },
  };
}

// ── The live hook sources across a restart (M56 spec 11, bridge/surface/edges.ts) ─────

/** `<stateDir>/surface/hook-sources.json`: the router's live sources, so a restart keeps "hooks: live". */
export function hookSourcesPath(stateDir: string): string {
  return join(stateDir, "surface", "hook-sources.json");
}

/** The most saved sources read back. One per hooked pane; a host has far fewer. */
const SAVED_SOURCES_MAX = 256;

/** The router's source store on disk. A missing or broken file reads as no sources. */
export function fileSourceStore(stateDir: string): SourceStore {
  const path = hookSourcesPath(stateDir);
  return {
    load(): readonly SavedSource[] {
      let rows: JsonValue[];
      try {
        const parsed = parseJson(readFileSync(path, "utf8"));
        rows = Array.isArray(parsed) ? parsed.slice(0, SAVED_SOURCES_MAX) : [];
      } catch {
        return [];
      }
      const out: SavedSource[] = [];
      for (const row of rows) {
        const object = asJsonObject(row);
        const session = asJsonString(object?.session);
        const paneId = asJsonString(object?.paneId);
        const record = object?.record === undefined ? null : parseEdge(JSON.stringify(object.record));
        if (session === undefined || paneId === undefined || record === null) continue;
        const modelAt = asJsonNumber(object?.modelAt);
        out.push(modelAt !== undefined && Number.isFinite(modelAt) ? { session, paneId, record, modelAt } : { session, paneId, record });
      }
      return out;
    },
    save(sources: readonly SavedSource[]): void {
      const temp = `${path}.${String(process.pid)}.tmp`;
      mkdirSync(join(stateDir, "surface"), { recursive: true, mode: 0o700 });
      writeFileSync(temp, `${JSON.stringify(sources)}\n`, { mode: 0o600 });
      renameSync(temp, path);
    },
  };
}

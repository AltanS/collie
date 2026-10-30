// THE HOOK TARGET REGISTRY (M56 spec 11, review J4): which bridges take hook edges on this host.
//
// The hook runs inside the agent's pane and knows nothing about the bridges. Before this registry it
// wrote into the default state dir only, so a bridge on any other state dir (a second instance, a
// lab) never saw an edge. Now each bridge that takes edges writes one small file here at boot:
//
//   $XDG_STATE_HOME/collie/hook-targets/<id>.json      (default ~/.local/state/collie/hook-targets/)
//   { "schemaVersion": 1, "stateDir": "/abs/path", "pid": 1234, "pidStartTime": 5678, "bootedAt": <ms>,
//     "mux": "herdr", "instance": "next", "port": 8788 }
//
// `mux`, `instance` and `port` are optional (M76 spec 02): they say which multiplexer the bridge
// drives, under which instance name (`default` for the host's first Collie) and on which port, so
// `collie mux list` reads the live bridges without dialling them. A record without them (a bridge of
// an older build) still parses and reads as unknown. The emitter ignores all three.
//
// and removes it on a clean stop. The emitter (`collie beacon emit`) reads the folder, deletes the
// file of a bridge whose pid is gone or was reused, and writes the edge into every live target's
// spool, hashing a prompt with that target's own salt. No live target: the emitter writes into its
// own state dir, as it always did.
//
// The id is a hash of the state dir, so a restarted bridge overwrites its own file and two bridges on
// one state dir share one file. Pure: paths, the id, the record. No file is touched here.

import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";

import { asJsonNumber, asJsonObject, asJsonString, parseJson, type JsonValue } from "../../web/src/lib/json.ts";

export const HOOK_TARGET_SCHEMA_VERSION = 1;
export const HOOK_TARGETS_SUBDIR = "hook-targets";
/** A target file's name: 16 hex characters and `.json`. Anything else in the folder is skipped. */
export const HOOK_TARGET_FILE = /^[0-9a-f]{16}\.json$/u;
/** The most target files the emitter reads. A host runs a handful of bridges, never this many. */
export const HOOK_TARGETS_MAX = 32;

/** One bridge that takes hook edges. */
export interface HookTargetRecord {
  readonly schemaVersion: number;
  /** The bridge's state dir: the edges go into `<stateDir>/edges/`. Absolute. */
  readonly stateDir: string;
  readonly pid: number;
  /** The pid's start time off `/proc`, null where there is none; guards against a reused pid. */
  readonly pidStartTime: number | null;
  readonly bootedAt: number;
  /** The multiplexer the bridge drives, or null for a record written before M76 spec 02. */
  readonly mux: string | null;
  /** The instance name (`default` for the host's first Collie), or null for an older record. */
  readonly instance: string | null;
  /** The port the bridge listens on, or null for an older record. */
  readonly port: number | null;
}

/** What a bridge says of itself in its target file, beyond the state dir and the pid. */
export interface HookTargetIdentity {
  readonly mux?: string | undefined;
  /** `null` is the host's first Collie, written as {@link HOOK_TARGET_DEFAULT_INSTANCE}. */
  readonly instance?: string | null | undefined;
  readonly port?: number | undefined;
}

/** How the host's first, unnamed Collie is written into the `instance` field. */
export const HOOK_TARGET_DEFAULT_INSTANCE = "default";

/** The longest `mux` or `instance` value a record keeps. Longer is not a name. */
const IDENTITY_NAME_MAX = 64;

/** The environment this module reads `XDG_STATE_HOME` from. */
export type HookTargetEnv = Readonly<Record<string, string | undefined>>;

/** `$XDG_STATE_HOME/collie/hook-targets`, or `~/.local/state/collie/hook-targets` without it. */
export function hookTargetsDir(env: HookTargetEnv, home: string): string {
  const xdg = env.XDG_STATE_HOME?.trim() ?? "";
  const base = xdg !== "" && isAbsolute(xdg) ? xdg : join(home, ".local", "state");
  return join(base, "collie", HOOK_TARGETS_SUBDIR);
}

/** The file name of a state dir's target: a short hash of the path. */
export function hookTargetFileName(stateDir: string): string {
  return `${createHash("sha256").update(stateDir).digest("hex").slice(0, 16)}.json`;
}

/** A target file's text as a record, or null for anything that is not one. */
export function parseHookTarget(text: string): HookTargetRecord | null {
  const row = asJsonObject(parseJson(text));
  if (row === undefined) return null;
  const stateDir = asJsonString(row.stateDir);
  const pid = asJsonNumber(row.pid);
  const bootedAt = asJsonNumber(row.bootedAt);
  const start = row.pidStartTime === null ? null : asJsonNumber(row.pidStartTime);
  if (asJsonNumber(row.schemaVersion) !== HOOK_TARGET_SCHEMA_VERSION) return null;
  if (stateDir === undefined || stateDir.length === 0 || stateDir.length > 4096 || !isAbsolute(stateDir)) return null;
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0 || bootedAt === undefined || start === undefined) return null;
  return {
    schemaVersion: HOOK_TARGET_SCHEMA_VERSION,
    stateDir,
    pid,
    pidStartTime: start,
    bootedAt,
    mux: identityName(row.mux),
    instance: identityName(row.instance),
    port: identityPort(row.port),
  };
}

/** An optional name field: a short non-empty string, else null. A wrong type never fails the record. */
function identityName(value: JsonValue | undefined): string | null {
  const text = asJsonString(value);
  return text === undefined || text.length === 0 || text.length > IDENTITY_NAME_MAX ? null : text;
}

/** An optional port field: a whole number from 1 to 65535, else null. */
function identityPort(value: JsonValue | undefined): number | null {
  const port = asJsonNumber(value);
  return port !== undefined && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** The identity fields as they are written into a target file. */
export interface HookTargetIdentityFields {
  mux?: string;
  instance?: string;
  port?: number;
}

/** The fields of a record's JSON text that name the bridge. Absent ones are left out of the file. */
export function identityFields(identity: HookTargetIdentity): HookTargetIdentityFields {
  const out: HookTargetIdentityFields = {};
  if (identity.mux !== undefined && identity.mux !== "") out.mux = identity.mux;
  if (identity.instance !== undefined) out.instance = identity.instance ?? HOOK_TARGET_DEFAULT_INSTANCE;
  if (identity.port !== undefined) out.port = identity.port;
  return out;
}

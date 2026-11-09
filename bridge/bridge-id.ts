import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isMemberId } from "./crew/identity.ts";
import { asJsonString, parseJsonObject } from "../web/src/lib/json.ts";

// THIS BRIDGE'S ONE STABLE ID (M94 review row 11): the key its tricks' parts, its trick sessions'
// scope keys and its Decisions' `from.memberId` go by. Never a host name: a host name changes when the
// machine is renamed, and trick programs bake the id into their own state files.
//
//   <stateDir>/bridge-id.json
//   { "v": 1, "install": "m_k3x9q2w7ab", "id": "<the id last kept>", "previous": "<id>" | null }
//
// THE ID is the crew member id when this bridge has one (the trust store's `self.memberId`), else the
// install id. The install id is `m_` and ten of `[a-z0-9]`, minted once and kept in this file; it is
// never minted again while the file holds one. Its `_` keeps it apart from every crew member id
// (`[a-z0-9-]`, crew/identity.ts), so the two can never name each other.
//
// RESOLVED ONCE, AT BOOT (bridge/index.ts). A bridge that joins a crew while it runs keeps serving the
// id it booted with until the next restart, so nothing keyed on it moves under a running trick.
//
// THE ALIAS. When the id this boot serves differs from the one the file last kept (the bridge joined
// a crew: install id to member id, or left one), `previous` is the old one, so a Decision posted and a
// tap sent under it still reach this bridge after the restart. One step back only.
//
// WRITTEN BY USE, NEVER AT START (solo zero-tax, solo-baseline.test.ts). Boot only reads the file. The
// first thing that keys something on the id calls `keep()`: a trick's run (its program may store it)
// and a post to the hill (the Decision stores it). Only then is the file written, whole to a temp
// file and renamed (0600, inside the state folder), and only when something in it changed. An install
// id minted at a boot that never kept it is thrown away with the process: nothing was keyed on it.

/** The file's name inside the state folder. */
export const BRIDGE_ID_FILE = "bridge-id.json";

/** An install id: `m_` and ten of `[a-z0-9]`. */
export const INSTALL_ID_RE = /^m_[a-z0-9]{10}$/;

const INSTALL_ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Entropy source, so a test pins an exact id. */
export type IdBytes = (n: number) => Uint8Array;

/** Mint an install id. Rejection sampling, so every character is equally likely. */
export function mintInstallId(bytes: IdBytes = (n) => randomBytes(n)): string {
  let out = "m_";
  // 252 is the largest multiple of 36 below 256: a byte at or above it would skew the draw.
  for (let round = 0; round < 32 && out.length < 12; round += 1) {
    for (const b of bytes(16)) {
      if (b >= 252) continue;
      out += INSTALL_ID_CHARS[b % 36];
      if (out.length === 12) break;
    }
  }
  if (!INSTALL_ID_RE.test(out)) throw new Error("could not mint an install id");
  return out;
}

/**
 * Whether a value is an id this bridge may serve: an install id or a crew member id. Never `trick`: a
 * trick session's id starts `trick:` (web/src/lib/tricks/schema.ts `isHostName` reserves the word).
 */
export function isBridgeId(value: string): boolean {
  return value !== "trick" && (INSTALL_ID_RE.test(value) || isMemberId(value));
}

/** The id this boot serves, and the one the file kept before when it was another. */
export interface BridgeIdentity {
  readonly id: string;
  /** The id served before a crew join or leave, still accepted on the way in. Null: none. */
  readonly previous: string | null;
  /** Write the id to the state folder, once per process, when something is about to be keyed on it. Never throws. */
  keep(): void;
}

interface BridgeIdFile {
  readonly install: string;
  readonly id: string | null;
  readonly previous: string | null;
}

/** The file as read, or null when it is absent; `"bad"` when it is there and does not read. */
function readFile(path: string): BridgeIdFile | null | "bad" {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return "bad";
  }
  const file = parseJsonObject(raw);
  const install = asJsonString(file?.install);
  if (file?.v !== 1 || install === undefined || !INSTALL_ID_RE.test(install)) return "bad";
  const id = asJsonString(file.id);
  const previous = asJsonString(file.previous);
  return {
    install,
    id: id !== undefined && isBridgeId(id) ? id : null,
    previous: previous !== undefined && isBridgeId(previous) ? previous : null,
  };
}

export interface ResolveBridgeIdOptions {
  readonly stateDir: string;
  /** This bridge's crew member id (the trust store's `self.memberId`), or null with no trust store. */
  readonly crewMemberId: string | null;
  readonly mint?: () => string;
  readonly now?: () => number;
  readonly warn?: (line: string) => void;
}

/**
 * Read `<stateDir>/bridge-id.json` and answer the id this boot serves. Writes nothing: `keep()` does,
 * at the first use. A file that is there but does not read is warned about now, and at `keep()` set
 * aside as `bridge-id.json.bad-<ms>` before a new one is written: there is no id left in it to keep.
 */
export function resolveBridgeId(opts: ResolveBridgeIdOptions): BridgeIdentity {
  const warn = opts.warn ?? ((line: string) => console.warn(line));
  const stateDir = opts.stateDir;
  const path = join(stateDir, BRIDGE_ID_FILE);
  const read = readFile(path);
  if (read === "bad") warn(`[bridge-id] ${path} did not read; a new install id replaces it at the first use`);
  const held = read === "bad" ? null : read;
  const install = held?.install ?? (opts.mint ?? mintInstallId)();
  const crew = opts.crewMemberId !== null && isBridgeId(opts.crewMemberId) ? opts.crewMemberId : null;
  const id = crew ?? install;
  const last = held?.id ?? null;
  // The id the file last kept, when it was another; else whatever alias the file already kept.
  const before = last !== null && last !== id ? last : (held?.previous ?? null);
  const previous = before === id ? null : before;
  let kept = false;
  const keep = (): void => {
    if (kept) return;
    kept = true;
    if (held !== null && held.install === install && held.id === id && held.previous === previous) return;
    try {
      if (read === "bad") renameSync(path, `${path}.bad-${String((opts.now ?? Date.now)())}`);
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const temp = `${path}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ v: 1, install, id, previous })}\n`, { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, path);
    } catch (err) {
      warn(`[bridge-id] could not save ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return { id, previous, keep };
}

/** Whether an id names this bridge: the one it serves, or the one it served before. */
export function isOwnId(identity: Pick<BridgeIdentity, "id" | "previous">, value: string): boolean {
  return value === identity.id || (identity.previous !== null && value === identity.previous);
}

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_FILE, diskTrickFs, isPictureName, walkTrickCode, type TrickFs } from "../tricks/code-hash.ts";
import { readSmallFile } from "../tricks/discover.ts";
import { isPictureBytes } from "../tricks/approved.ts";
import { ORIGIN_FILE } from "../tricks/origin.ts";
import { approvedCopyDir, switchesPath, trickStateDir } from "../tricks/paths.ts";
import { parseSwitches } from "../tricks/switches.ts";
import {
  CARRIED_TRICKS_MAX,
  CARRY_ORIGIN_MAX,
  CARRY_PART_BYTES,
  CARRY_STATE_FILES_MAX,
  CARRY_STATE_TRICK_MAX,
  checkCarriedFiles,
  statePathProblem,
  type CarriedFile,
  type CarriedTrick,
  type CodeChunk,
  type StateFile,
} from "./standby-tricks.ts";

// THE LEAD'S HALF OF THE TRICKS COPY (CREW_PROTOCOL §25): what it would send its deputy, read off its own
// disk. Every trick that is ON with an approved version, from that version's approved copy (approved.ts),
// never from the live folder: the deputy carries what the person approved here, and nothing else.
//
// A trick whose approved copy does not walk, holds a link or a file the wire cannot name is left out of
// the list. It keeps running here; the deputy simply cannot resume it, and its standby page does not
// list it. A file name the proposal reader refuses (a colon, a non-NFC name, deeper than 8 folders) is
// such a case: rare, and safe in the direction that matters.

/** Read a file as text, or null. */
async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Whether the file at `path` is executable by anyone. */
async function executable(path: string): Promise<boolean> {
  const st = await lstat(path).catch(() => null);
  return st !== null && (st.mode & 0o111) !== 0;
}

/** One state file the lead would send, before its bytes are read. */
export interface StateEntry {
  /** `state/…`, `media/…` or `captures/…`. */
  rel: string;
  /** The file on the lead's disk. */
  path: string;
  size: number;
  mtimeMs: number;
}

/** Every regular file under `root`, by `lstat`, no link followed, at most `max`. */
async function listFiles(fs: TrickFs, root: string, max: number): Promise<{ rel: string; size: number; mtimeMs: number }[]> {
  const out: { rel: string; size: number; mtimeMs: number }[] = [];
  const queue = [""];
  for (let pass = 0; queue.length > 0 && pass < max; pass += 1) {
    const rel = queue.shift();
    if (rel === undefined) break;
    const listed = await fs.list(rel === "" ? root : join(root, rel));
    if (!listed.ok) continue;
    for (const item of listed.entries.toSorted((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1))) {
      const child = rel === "" ? item.name : `${rel}/${item.name}`;
      if (item.kind === "dir") queue.push(child);
      if (item.kind !== "file") continue;
      const st = await fs.lstat(join(root, child));
      if (st === null || st.kind !== "file") continue;
      out.push({ rel: child, size: st.size, mtimeMs: st.mtimeMs });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/**
 * The state a trick carries: its state folder (`<stateDir>/tricks/<id>/`), then the pictures of its
 * approved copy's `media/`, then those of `captures/`, in that order and within
 * {@link CARRY_STATE_TRICK_MAX}: what does not fit is left out, `captures/` first. `inputs/` never goes:
 * the files there are fetched again after a takeover. A name the wire cannot carry is left out.
 */
export async function stateEntries(stateDir: string, copyDir: string, id: string, fs: TrickFs = diskTrickFs): Promise<StateEntry[]> {
  const out: StateEntry[] = [];
  let bytes = 0;
  const roots: [string, string][] = [
    ["state", trickStateDir(stateDir, id)],
    ["media", join(copyDir, "media")],
    ["captures", join(copyDir, "captures")],
  ];
  for (const [part, root] of roots) {
    const top = await fs.lstat(root);
    if (top === null || top.kind !== "dir") continue;
    for (const file of await listFiles(fs, root, CARRY_STATE_FILES_MAX)) {
      const rel = `${part}/${file.rel}`;
      if (statePathProblem(rel) !== null) continue;
      if (part !== "state" && !isPictureName(file.rel)) continue;
      if (out.length >= CARRY_STATE_FILES_MAX || bytes + file.size > CARRY_STATE_TRICK_MAX) continue;
      bytes += file.size;
      out.push({ rel, path: join(root, file.rel), size: file.size, mtimeMs: file.mtimeMs });
    }
  }
  return out;
}

/** The digest of a state listing (paths, sizes, times), or null for none. Cheap: no file is read. */
export function stateDigest(entries: readonly StateEntry[]): string | null {
  if (entries.length === 0) return null;
  const h = createHash("sha256");
  for (const e of entries) h.update(`${e.rel}\0${String(e.size)}\0${String(e.mtimeMs)}\n`);
  return h.digest("hex");
}

/** The state files with their bytes. A picture that is not one by its first bytes is left out. */
export async function readStateFiles(entries: readonly StateEntry[], fs: TrickFs = diskTrickFs): Promise<StateFile[]> {
  const out: StateFile[] = [];
  for (const entry of entries) {
    const bytes = await fs.read(entry.path, CARRY_STATE_TRICK_MAX);
    if (bytes === null) continue;
    if (!entry.rel.startsWith("state/") && !isPictureBytes(bytes)) continue;
    out.push({ rel: entry.rel, bytes });
  }
  return out;
}

/** One trick of the list, with where its bytes are on the lead's disk. */
export interface LeadTrick {
  trick: CarriedTrick;
  copyDir: string;
  state: StateEntry[];
}

/** One trick as the list carries it, or null when it cannot be carried. */
async function leadTrick(stateDir: string, configDir: string, id: string, entry: { hash: string; auto: boolean; at: string; by: string; powers: string | null }, fs: TrickFs): Promise<LeadTrick | null> {
  const copyDir = approvedCopyDir(configDir, id, entry.hash);
  const walk = await walkTrickCode(fs, copyDir);
  if (!walk.ok || walk.entries.some((e) => e.kind !== "file")) return null;
  const files: CarriedFile[] = [];
  for (const e of walk.entries) files.push({ rel: e.rel, size: e.size, x: await executable(join(copyDir, e.rel)) });
  if (checkCarriedFiles(files) !== null) return null;
  const config = await readSmallFile(fs, copyDir, CONFIG_FILE);
  if (config.kind === "refused") return null;
  const originStat = await fs.lstat(join(copyDir, ORIGIN_FILE));
  const origin = originStat !== null && originStat.kind === "file" && originStat.size <= CARRY_ORIGIN_MAX ? await readText(join(copyDir, ORIGIN_FILE)) : null;
  const state = await stateEntries(stateDir, copyDir, id, fs);
  const trick: CarriedTrick = {
    id,
    hash: entry.hash,
    auto: entry.auto,
    at: entry.at.slice(0, 64),
    by: entry.by.slice(0, 64),
    powers: entry.powers,
    config: config.kind === "bytes" ? Buffer.from(config.bytes).toString("base64") : null,
    origin: origin !== null && Buffer.byteLength(origin, "utf8") <= CARRY_ORIGIN_MAX ? origin : null,
    files,
    state: stateDigest(state),
  };
  return { trick, copyDir, state };
}

/**
 * Every trick that is ON on this lead with an approved version, as the list would carry it, sorted by
 * id, at most {@link CARRIED_TRICKS_MAX}. Read fresh from `switches.json` and the approved copies.
 */
export async function leadTricks(stateDir: string, configDir: string, fs: TrickFs = diskTrickFs): Promise<LeadTrick[]> {
  const read = parseSwitches(await readText(switchesPath(stateDir)));
  if (read.problem !== null || (read.switches.version ?? 0) < 3) return [];
  const out: LeadTrick[] = [];
  for (const id of [...read.switches.on.keys()].toSorted()) {
    const entry = read.switches.on.get(id);
    if (entry === undefined || entry.hash === null) continue;
    const trick = await leadTrick(stateDir, configDir, id, { hash: entry.hash, auto: entry.auto, at: entry.at, by: entry.by, powers: entry.powers }, fs);
    if (trick !== null) out.push(trick);
    if (out.length >= CARRIED_TRICKS_MAX) break;
  }
  return out;
}

/**
 * A trick's code as parts of at most {@link CARRY_PART_BYTES} bytes, in path order: each part a list of
 * chunks appended to files. Every file appears at least once, so an empty file is made too. The bytes are
 * read from the approved copy now; a copy that moved since the list makes a part the deputy refuses.
 */
export async function codeParts(copyDir: string, files: readonly CarriedFile[], fs: TrickFs = diskTrickFs): Promise<CodeChunk[][] | null> {
  const parts: CodeChunk[][] = [];
  let current: CodeChunk[] = [];
  let room = CARRY_PART_BYTES;
  for (const file of files) {
    const bytes = await fs.read(join(copyDir, file.rel), file.size + 1);
    if (bytes === null || bytes.length !== file.size) return null;
    let at = 0;
    // Bounded: each pass moves `at` forward by at least one byte, or emits the one empty chunk.
    for (let pass = 0; pass <= file.size; pass += 1) {
      if (room === 0) {
        parts.push(current);
        current = [];
        room = CARRY_PART_BYTES;
      }
      const take = Math.min(room, file.size - at);
      current.push({ rel: file.rel, at, bytes: bytes.subarray(at, at + take) });
      at += take;
      room -= take;
      if (at >= file.size) break;
    }
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

import { createHash } from "node:crypto";
import { join } from "node:path";

import type { JsonValue } from "../json.ts";
import { parseManifest, type TrickManifest, type Refusal } from "../../web/src/lib/tricks/schema.ts";
import { CONFIG_FILE, diskTrickFs, hashCodeEntries, walkFingerprint, walkTrickCode, type FsStat, type TrickFs } from "./code-hash.ts";
import { ORIGIN_FILE, readOrigin, type TrickOrigin } from "./origin.ts";
import { MANIFEST_FILE } from "./paths.ts";

// FINDING TRICKS (M94 slice 01): every folder under `<configDir>/tricks/` is a trick, named by the folder.
// A folder whose `trick.toml` is missing or refused is still listed, with its refusals, and never run.
//
// Reread on change, on the operator-file posture (operator-file.ts): each scan walks every trick folder
// with `lstat` only (code-hash.ts), and only a folder whose fingerprint moved is read again: its
// manifest parsed, its `config.toml` and its code hashed. The fingerprint covers the code files,
// `config.toml` and the origin record (origin.ts), never `media/`, `captures/` or a `*.log`, so a program
// that writes its log or its pictures into its own folder moves nothing.
//
// Hardened reads: `trick.toml` and `config.toml` must be regular files of at most 64 KiB, opened without
// following a symlink and without blocking on a FIFO. One whole scan has {@link SCAN_TIMEOUT_MS}; a scan
// that runs over keeps the last good result, and no second scan starts while the stuck one runs, so a
// stuck read never blocks the list, a tap, a switch or a timer. A tricks folder that cannot be listed
// for any reason but "not there" keeps the last good result too.

/** The most trick folders read. A config folder with more is a mistake, not a setup. */
export const TRICKS_MAX = 64;
/** The most bytes of `trick.toml` or `config.toml` read. A larger one refuses the trick. */
export const MANIFEST_BYTES_MAX = 64 * 1024;
/** How long one whole scan may take before the last good result is kept. */
export const SCAN_TIMEOUT_MS = 5000;

/** One trick folder as the scan found it. */
export interface FoundTrick {
  /** The folder's name, which the manifest's `id` must match. */
  id: string;
  dir: string;
  /** Moves when a code file or `config.toml` changes. */
  fingerprint: string;
  /** Present when the manifest parsed with no refusal other than a "later" one, and the code hashed. */
  manifest?: TrickManifest;
  refusals: Refusal[];
  /** The SHA-256 of the trick's code (code-hash.ts), when it could be taken. */
  codeHash?: string;
  /** The SHA-256 of `config.toml`, or null when the folder has none. */
  configHash: string | null;
  /** Where `collie trick add` took the trick from (origin.ts), when the folder has a record of it. */
  origin?: TrickOrigin;
}

/** What a scan saw: whether the tricks folder exists at all, and each trick folder in name order. */
export interface TricksScan {
  exists: boolean;
  tricks: FoundTrick[];
  /** Set when this is the last good result, kept: the scan ran over its time or the folder could not be listed. */
  kept?: string;
}

/** A `trick.toml` read: the manifest when it parsed, and every refusal. */
export interface ManifestRead {
  manifest?: TrickManifest;
  refusals: Refusal[];
}

/** Parse a `trick.toml` text for the folder `id`. Total: TOML errors become one refusal. */
export function readManifestText(text: string | null, id: string): ManifestRead {
  if (text === null) return { refusals: [{ code: "missing", path: "", reason: `There is no ${MANIFEST_FILE} in the folder.` }] };
  let doc: JsonValue;
  try {
    // SAFETY: `Bun.TOML.parse` answers with a parsed document, and `parseManifest` is its only reader:
    // it checks every field it names before it believes it.
    doc = Bun.TOML.parse(text) as JsonValue;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { refusals: [{ code: "type", path: "", reason: `${MANIFEST_FILE} is not TOML: ${why}` }] };
  }
  const parsed = parseManifest(doc, { folder: id });
  return parsed.manifest === undefined ? { refusals: parsed.refusals } : { manifest: parsed.manifest, refusals: parsed.refusals };
}

/** A small file read the hardened way: the bytes, absent (null), or a refusal. */
export type SmallFileRead = { kind: "absent" } | { kind: "bytes"; bytes: Uint8Array } | { kind: "refused"; refusal: Refusal };

/** Read `name` in `dir`: `lstat` first, a regular file only, at most {@link MANIFEST_BYTES_MAX} bytes. */
export async function readSmallFile(fs: TrickFs, dir: string, name: string): Promise<SmallFileRead> {
  const path = join(dir, name);
  const st = await fs.lstat(path);
  if (st === null) return { kind: "absent" };
  if (st.kind !== "file") return { kind: "refused", refusal: { code: "type", path: "", reason: `${name} is not a regular file.` } };
  if (st.size > MANIFEST_BYTES_MAX) return { kind: "refused", refusal: { code: "size", path: "", reason: `${name} is larger than ${MANIFEST_BYTES_MAX / 1024} KiB.` } };
  const bytes = await fs.read(path, MANIFEST_BYTES_MAX + 1);
  if (bytes === null) return { kind: "refused", refusal: { code: "type", path: "", reason: `${name} cannot be read.` } };
  if (bytes.length > MANIFEST_BYTES_MAX) return { kind: "refused", refusal: { code: "size", path: "", reason: `${name} is larger than ${MANIFEST_BYTES_MAX / 1024} KiB.` } };
  return { kind: "bytes", bytes };
}

/** Read and parse a trick folder's manifest the hardened way. */
export async function readManifestFile(fs: TrickFs, dir: string, id: string): Promise<ManifestRead> {
  const read = await readSmallFile(fs, dir, MANIFEST_FILE);
  if (read.kind === "refused") return { refusals: [read.refusal] };
  return readManifestText(read.kind === "absent" ? null : new TextDecoder().decode(read.bytes), id);
}

/** One entry's `lstat` as a word for a fingerprint: it moves when the entry is written or replaced. */
function statStamp(st: FsStat | null): string {
  return st === null ? "none" : `${st.kind}:${String(st.size)}:${String(st.mtimeMs)}:${String(st.ino)}`;
}

/** Read one trick folder: reuse `known` when the fingerprint did not move. */
async function scanFolder(fs: TrickFs, root: string, id: string, known: FoundTrick | undefined): Promise<FoundTrick> {
  const dir = join(root, id);
  const walk = await walkTrickCode(fs, dir);
  const config = await fs.lstat(join(dir, CONFIG_FILE));
  const origin = await fs.lstat(join(dir, ORIGIN_FILE));
  // The origin record is outside the code hash, but its stamp is in the fingerprint, so a rewrite shows.
  const configStamp = `${statStamp(config)}|${statStamp(origin)}`;
  const fingerprint = walk.ok ? walkFingerprint(walk.entries, configStamp) : `refused:${walk.reason}:${configStamp}`;
  if (known !== undefined && known.fingerprint === fingerprint) return known;

  const read = await readManifestFile(fs, dir, id);
  const refusals = [...read.refusals];
  let configHash: string | null = null;
  const configRead = config === null ? ({ kind: "absent" } as const) : await readSmallFile(fs, dir, CONFIG_FILE);
  if (configRead.kind === "refused") refusals.push(configRead.refusal);
  if (configRead.kind === "bytes") configHash = createHash("sha256").update(configRead.bytes).digest("hex");
  if (!walk.ok) refusals.push({ code: "count", path: "", reason: walk.reason });
  const found: FoundTrick = { id, dir, fingerprint, refusals, configHash };
  if (walk.ok) found.codeHash = await hashCodeEntries(fs, dir, walk.entries);
  const record = origin === null ? null : await readOrigin(dir, fs);
  if (record !== null) found.origin = record;
  if (read.manifest !== undefined && walk.ok && configRead.kind !== "refused") found.manifest = read.manifest;
  return found;
}

/** A folder past {@link TRICKS_MAX}: listed with its reason, never read. */
function overflowTrick(root: string, id: string): FoundTrick {
  return {
    id,
    dir: join(root, id),
    fingerprint: "over-the-cap",
    refusals: [{ code: "count", path: "", reason: `There are more than ${TRICKS_MAX} trick folders, so this one is not read. Remove a trick you do not use.` }],
    configHash: null,
  };
}

/**
 * A scanner that remembers what it parsed: `scan()` lists the tricks folder and reads again only the
 * trick folders whose fingerprint moved. A folder name that is not a trick id is listed with one refusal.
 */
export interface TrickScanner {
  /**
   * Scan every folder. `prefer` names tricks to read first when there are more than {@link TRICKS_MAX}
   * (the ones switched on); a folder read once stays read while it is there.
   */
  scan(prefer?: ReadonlySet<string>): Promise<TricksScan>;
  /** Read one folder again now (before a run), or null when it is gone or not read. Never throws. */
  one(id: string): Promise<FoundTrick | null>;
}

export interface TrickScannerOptions {
  fs?: TrickFs;
  timeoutMs?: number;
  warn?: (line: string) => void;
}

/** `work` within `ms`, or `null` when it ran over. The work goes on, unawaited. */
export async function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

export function createTrickScanner(root: string, opts: TrickScannerOptions = {}): TrickScanner {
  const fs = opts.fs ?? diskTrickFs;
  const timeoutMs = opts.timeoutMs ?? SCAN_TIMEOUT_MS;
  const warn = opts.warn ?? (() => {});
  const cache = new Map<string, FoundTrick>();
  /** The folders read, in the order they were first admitted: never pushed out while present. */
  let admitted = new Set<string>();
  let last: TricksScan | null = null;
  let running: Promise<TricksScan> | null = null;

  const keep = (reason: string): TricksScan => {
    warn(reason);
    return last === null ? { exists: false, tricks: [], kept: reason } : { ...last, kept: reason };
  };

  const scanAll = async (prefer: ReadonlySet<string>): Promise<TricksScan> => {
    const listed = await fs.list(root);
    if (!listed.ok && listed.missing) {
      cache.clear();
      admitted = new Set();
      return { exists: false, tricks: [] };
    }
    if (!listed.ok) return keep(`the tricks folder could not be listed, the last scan stays: ${listed.error}`);
    const names = listed.entries
      .filter((e) => e.kind === "dir" && !e.name.startsWith("."))
      .map((e) => e.name)
      .toSorted();
    const take = [...names.filter((n) => admitted.has(n)), ...names.filter((n) => !admitted.has(n) && prefer.has(n)), ...names.filter((n) => !admitted.has(n) && !prefer.has(n))];
    const read = new Set(take.slice(0, TRICKS_MAX));
    const tricks: FoundTrick[] = [];
    for (const id of names) {
      if (!read.has(id)) {
        tricks.push(overflowTrick(root, id));
        continue;
      }
      const found = await scanFolder(fs, root, id, cache.get(id));
      cache.set(id, found);
      tricks.push(found);
    }
    for (const id of cache.keys()) if (!read.has(id)) cache.delete(id);
    admitted = read;
    return { exists: true, tricks };
  };

  return {
    async scan(prefer = new Set()) {
      if (running !== null) return keep("the last tricks scan is still running, its result stays");
      const work = scanAll(prefer);
      running = work;
      const done = work.then(
        (scan) => {
          if (scan.kept === undefined) last = scan;
          return scan;
        },
        (err: Error) => keep(`the tricks folder could not be read: ${err.message}`),
      );
      void done.finally(() => {
        if (running === work) running = null;
      });
      const result = await within(done, timeoutMs);
      return result ?? keep(`a tricks scan took longer than ${timeoutMs / 1000} s, the last scan stays`);
    },
    async one(id) {
      if (!admitted.has(id)) return null;
      const work = (async () => {
        const st = await fs.lstat(join(root, id));
        if (st === null || st.kind !== "dir") return null;
        const found = await scanFolder(fs, root, id, cache.get(id));
        cache.set(id, found);
        return found;
      })().catch(() => null);
      return await within(work, timeoutMs);
    },
  };
}

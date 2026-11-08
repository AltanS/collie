import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { JsonValue } from "../json.ts";
import { parseManifest, type TrickManifest, type Refusal } from "../../web/src/lib/tricks/schema.ts";
import { MANIFEST_FILE } from "./paths.ts";

// FINDING TRICKS (M94 slice 01): every folder under `<configDir>/tricks/` is a trick, named by the folder.
// A folder whose `trick.toml` is missing or refused is still listed, with its refusals, and never run.
//
// Reread on change, on the operator-file posture (operator-file.ts): each scan stats the folder and
// the files directly in each trick folder, and only a folder whose fingerprint moved is parsed again.
// The fingerprint is the newest mtime among the folder and its direct entries, plus their count, so an
// edit in place, a save through a rename and a new file all move it. A change is what restarts a trick
// that backed off (design §3.2: an edit in the folder, or a tap, restarts it).

/** The most trick folders read. A config folder with more is a mistake, not a setup. */
export const TRICKS_MAX = 64;
/** The most entries of one trick folder taken into its fingerprint. */
const FINGERPRINT_ENTRIES = 256;

/** One trick folder as the scan found it. */
export interface FoundTrick {
  /** The folder's name, which the manifest's `id` must match. */
  id: string;
  dir: string;
  /** Moves when the folder or a file directly in it changes. */
  fingerprint: string;
  /** Present when the manifest parsed with no refusal other than a "later" one. */
  manifest?: TrickManifest;
  refusals: Refusal[];
}

/** What a scan saw: whether the tricks folder exists at all, and each trick folder in name order. */
export interface TricksScan {
  exists: boolean;
  tricks: FoundTrick[];
}

/** The file system a scan reads, behind a seam so a test can count reads. */
export interface ScanIo {
  /** Entry names of a folder, with whether each is a folder, or null when it cannot be listed. */
  list(dir: string): Promise<{ name: string; dir: boolean }[] | null>;
  /** mtime in ms, or null. */
  mtime(path: string): Promise<number | null>;
  read(path: string): Promise<string | null>;
}

export const diskScanIo: ScanIo = {
  async list(dir) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, dir: e.isDirectory() }));
    } catch {
      return null;
    }
  },
  async mtime(path) {
    try {
      return (await stat(path)).mtimeMs;
    } catch {
      return null;
    }
  },
  async read(path) {
    try {
      return await Bun.file(path).text();
    } catch {
      return null;
    }
  },
};

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

async function fingerprintOf(io: ScanIo, dir: string): Promise<string> {
  const own = (await io.mtime(dir)) ?? 0;
  const entries = (await io.list(dir)) ?? [];
  let newest = own;
  for (const entry of entries.slice(0, FINGERPRINT_ENTRIES)) {
    const m = await io.mtime(join(dir, entry.name));
    if (m !== null && m > newest) newest = m;
  }
  return `${newest}:${entries.length}`;
}

/**
 * A scanner that remembers what it parsed: `scan()` lists the tricks folder and reparses only the trick
 * folders whose fingerprint moved. A folder name that is not a trick id is listed with one refusal.
 */
export interface TrickScanner {
  scan(): Promise<TricksScan>;
}

export function createTrickScanner(root: string, io: ScanIo = diskScanIo): TrickScanner {
  const cache = new Map<string, FoundTrick>();
  return {
    async scan() {
      const entries = await io.list(root);
      if (entries === null) {
        cache.clear();
        return { exists: false, tricks: [] };
      }
      const names = entries
        .filter((e) => e.dir && !e.name.startsWith("."))
        .map((e) => e.name)
        .toSorted()
        .slice(0, TRICKS_MAX);
      const tricks: FoundTrick[] = [];
      for (const id of names) {
        const dir = join(root, id);
        const fingerprint = await fingerprintOf(io, dir);
        const known = cache.get(id);
        if (known !== undefined && known.fingerprint === fingerprint) {
          tricks.push(known);
          continue;
        }
        const read = readManifestText(await io.read(join(dir, MANIFEST_FILE)), id);
        const found: FoundTrick = { id, dir, fingerprint, refusals: read.refusals };
        if (read.manifest !== undefined) found.manifest = read.manifest;
        cache.set(id, found);
        tricks.push(found);
      }
      for (const id of cache.keys()) if (!names.includes(id)) cache.delete(id);
      return { exists: true, tricks };
    },
  };
}

import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_FILE, PICTURE_DIRS } from "../bridge/tricks/code-hash.ts";
import { foldKey, isConfigPath, PROPOSE_LIMITS, type ProposedFile } from "../bridge/tricks/propose-wire.ts";

// The folder read of `collie trick propose` (crew slice 8), on its own so `collie trick check` can count
// the cards of the same files without a loop of imports: regular files only, never through a link,
// within the caps. Left behind, never read: dot files and dot folders, `node_modules/`, `*.log`, the
// bridge's own `inputs/`, `media/` and `captures/`, and `config.toml`.

/** The most entries the folder walk looks at, skipped ones included, before it gives up. */
export const PROPOSE_WALK_MAX = 2000;

/** The folder read for a proposal: the files to send, and how many were left behind. */
export type FolderRead = { ok: true; files: ProposedFile[]; left: number; config: boolean } | { ok: false; error: string };

/** The top-level names left behind, folded: the bridge's `inputs/`, the person's pictures and settings. */
const LEFT_TOP: ReadonlySet<string> = new Set(["inputs", ...PICTURE_DIRS, CONFIG_FILE]);

/** Whether a name is left behind: not code, or the bridge's own. */
function leftBehind(rel: string, isDir: boolean): boolean {
  const steps = rel.split("/");
  const name = steps.at(-1) ?? "";
  if (steps.some((step) => step.startsWith(".") || foldKey(step) === "node_modules")) return true;
  // The bridge's own inputs/, the person's pictures and settings: a proposal carries code only.
  if (steps.length === 1 && LEFT_TOP.has(foldKey(name))) return true;
  if (!isDir && name.endsWith(".log")) return true;
  return false;
}

/** Read a trick folder for a proposal: regular files only, never through a link, within the caps. */
export async function readTrickFolder(folder: string): Promise<FolderRead> {
  const files: ProposedFile[] = [];
  let left = 0;
  let config = false;
  let seen = 0;
  let bytes = 0;
  const walk = async (rel: string, depth: number): Promise<string | null> => {
    const here = rel === "" ? folder : join(folder, rel);
    const entries = await readdir(here, { withFileTypes: true });
    for (const entry of entries.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      seen += 1;
      if (seen > PROPOSE_WALK_MAX) return `The folder holds more than ${String(PROPOSE_WALK_MAX)} entries. A trick is small.`;
      const sub = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const st = await lstat(join(folder, sub));
      if (leftBehind(sub, st.isDirectory())) {
        left += 1;
        if (isConfigPath(sub)) config = true;
        continue;
      }
      if (st.isSymbolicLink()) return `${sub} is a symbolic link. A trick holds regular files only.`;
      if (st.isDirectory()) {
        if (depth >= PROPOSE_LIMITS.depth) return `${sub} sits deeper than ${String(PROPOSE_LIMITS.depth)} folders.`;
        const deeper = await walk(sub, depth + 1);
        if (deeper !== null) return deeper;
        continue;
      }
      if (!st.isFile()) return `${sub} is not a regular file. A trick holds regular files only.`;
      bytes += st.size;
      if (files.length + 1 > PROPOSE_LIMITS.files) return `The trick holds more than ${String(PROPOSE_LIMITS.files)} files.`;
      if (bytes > PROPOSE_LIMITS.bytes) return `The trick holds more than ${String(PROPOSE_LIMITS.bytes / (1024 * 1024))} MB.`;
      const body = await readFile(join(folder, sub));
      files.push({ rel: sub, bytes: new Uint8Array(body.buffer, body.byteOffset, body.byteLength), executable: (st.mode & 0o111) !== 0 });
    }
    return null;
  };
  try {
    const error = await walk("", 0);
    return error === null ? { ok: true, files, left, config } : { ok: false, error };
  } catch (err) {
    return { ok: false, error: `The folder could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
}

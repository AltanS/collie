import { join } from "node:path";

import { asJsonNumber, asJsonObject, asJsonString, parseJson } from "../../web/src/lib/json.ts";
import { diskTrickFs, type TrickFs } from "./code-hash.ts";

// WHERE A TRICK CAME FROM (M94 review 15). `collie trick add` writes one dot file into the trick folder it
// makes, and `collie trick update` rewrites it:
//
//   { "v": 1, "url": "https://github.com/AltanS/collie-tricks", "ref": "v1", "commit": "<40 hex>",
//     "subdir": "legs", "at": "2026-11-10T09:41:00.000Z" }
//
// `ref` is what the person asked for (null for the repository's default branch), `commit` what it
// resolved to, `subdir` the folder inside the repository (null for its top). The file starts with a dot,
// so the code hash leaves it out (code-hash.ts `skippedName`): writing it never stops a trick, and the
// consent stays with the code. `update` is refused for a folder without one, and the bridge shows it on
// the trick's row as its provenance. A file that does not parse reads as no origin.

/** The origin record inside a trick folder. A dot file: outside the code hash. */
export const ORIGIN_FILE = ".collie-origin.json";
/** The most bytes of the origin record read. */
const ORIGIN_BYTES_MAX = 8 * 1024;

export interface TrickOrigin {
  url: string;
  /** The branch, tag or commit asked for, or null for the default branch. */
  ref: string | null;
  /** The commit the ref resolved to, 40 hex. */
  commit: string;
  /** The folder inside the repository, or null for its top. */
  subdir: string | null;
  /** When it was added or last updated, an instant. */
  at: string;
}

/** The record's text. */
export function renderOrigin(origin: TrickOrigin): string {
  const { url, ref, commit, subdir, at } = origin;
  return `${JSON.stringify({ v: 1, url, ref, commit, subdir, at }, null, 2)}\n`;
}

/** The record from its text, or null when it is not one. */
export function parseOrigin(text: string | null): TrickOrigin | null {
  if (text === null) return null;
  const doc = asJsonObject(parseJson(text));
  if (doc === undefined || asJsonNumber(doc.v) !== 1) return null;
  const url = asJsonString(doc.url);
  const commit = asJsonString(doc.commit);
  const at = asJsonString(doc.at);
  if (url === undefined || commit === undefined || !/^[0-9a-f]{40}$/u.test(commit) || at === undefined) return null;
  const ref = doc.ref === null ? null : asJsonString(doc.ref);
  const subdir = doc.subdir === null ? null : asJsonString(doc.subdir);
  if (ref === undefined || subdir === undefined) return null;
  return { url, ref, commit, subdir, at };
}

/** Read a trick folder's origin record: a regular file of at most 8 KiB, never through a symlink. */
export async function readOrigin(dir: string, fs: TrickFs = diskTrickFs): Promise<TrickOrigin | null> {
  const path = join(dir, ORIGIN_FILE);
  const st = await fs.lstat(path);
  if (st === null || st.kind !== "file" || st.size > ORIGIN_BYTES_MAX) return null;
  const bytes = await fs.read(path, ORIGIN_BYTES_MAX);
  return bytes === null ? null : parseOrigin(new TextDecoder().decode(bytes));
}

/** A short name for the repository: `owner/repo` on GitHub, else the host and path, no `.git`. */
export function originRepoName(url: string): string {
  const bare = url.replace(/^https:\/\//u, "").replace(/\.git$/u, "").replace(/\/+$/u, "");
  return bare.startsWith("github.com/") ? bare.slice("github.com/".length) : bare;
}

/** One short word for `collie trick list`: `owner/repo@abc1234`, with `/subdir` when there is one. */
export function originShort(origin: TrickOrigin): string {
  const where = origin.subdir === null ? originRepoName(origin.url) : `${originRepoName(origin.url)}/${origin.subdir}`;
  return `${where}@${origin.commit.slice(0, 7)}`;
}

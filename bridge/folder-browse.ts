// THE NEW PAGE'S FOLDER BROWSER — the sub-folders of one folder under home, by name (#467).
//
// `GET /api/folders/browse?path=<text>` takes what the New page's Folder field holds and answers the
// folder it names, or the nearest folder above it that exists, with the rest of the text as a name
// filter. So `~/src/plektra-` lists `~/src` narrowed to names that start with `plektra-`, which is the
// typeahead and the thumb list in one read. Read-only by construction: nothing here writes, creates,
// renames or deletes, and nothing is opened but a directory handle.
//
// ── THE FILES VIEW'S BOUND, WITH HOME AS THE ROOT ───────────────────────────────────────────────
// This is the Files view's reader (bridge/files-view.ts, ADR 0083) pointed at a different root, not
// a new place a client value becomes a path. The rules are that view's, one for one:
//
//   1. The ROOT is never the client's. It is this bridge's home folder, and every check runs on home's
//      REAL path. A home that is the whole disk (`/`) browses nothing.
//   2. The text is resolved by the New page's own rule (`askedFolder` in bridge/server.ts, the one
//      `/api/launch` uses): empty is home, `~` and `~/x` are under home, a name with no leading `/` or
//      `~` is under home, and an absolute path is itself. A control character, a `..` segment or a
//      `~name` is refused there, before this module sees it. What is left must lie under home as
//      written (home as given, or home's real path), and the segments below home are refused on their
//      shape by the Files view's own grammar (`parseRelPath`): an empty, `.` or `..` segment, NUL, a
//      backslash, over 4096 bytes, a `.git` segment, and on Windows its reserved names.
//   3. The walk up stops at the first folder that EXISTS. Each step is resolved through
//      `containedRealpath` against home's real path, so a symlink that leads out of home is never
//      followed: a step that is there (a link out, a loop, a dangling link) but does not resolve
//      inside home is refused, not walked past. A step that is absent is walked past.
//   4. Denied for list and walk alike: a `.git` segment, the bridge's own state and config folders,
//      and a state secret's basename (`isDeniedPath` in bridge/files-view.ts, case-folded everywhere).
//      A denied entry is never listed; a denied folder named in the text is refused.
//
// Every refusal is the same answer, `unknown-path`, as in the Files view: outside home, denied, a link
// out and a home that cannot be read cannot be told apart by anything the client sees.
//
// ── NAMES ONLY ──────────────────────────────────────────────────────────────────────────────────
// A row is a sub-folder's name and one bit: whether it holds a `.git` entry (one `lstat`, a folder or
// a worktree's file). No size, no time, no file, no contents. Dot-folders are left out unless the
// filter itself starts with a dot, because a person who typed `~/.con` asked for them. A symlink is
// listed when it leads to a folder inside home and is not denied. At most {@link MAX_BROWSE_FOLDERS}
// rows, sorted by name; `truncated` says more matched.

import { type Dirent } from "node:fs";
import { lstat, opendir, stat } from "node:fs/promises";

import { isAbsoluteFolder } from "./changes-root.ts";
import { deniedFolders, foldingHost, isDeniedPath, isGitSegment, parseRelPath, UNKNOWN_PATH, type FilesResult } from "./files-view.ts";
import { isStateSecretName } from "./acl-policy.ts";
import { HOST, type Host, isInside, splitPath } from "./host.ts";
import { containedRealpath, realpathOf } from "./journal/files.ts";
import type { FolderBrowseEntry, FolderBrowseResponse } from "./types.ts";

/** Rows one answer carries, sorted by name. More matching folders set `truncated`. */
export const MAX_BROWSE_FOLDERS = 200;
/**
 * Matching folder entries collected before the directory read stops. Sorting needs more than the
 * rows shown, so the first 200 by name are the first 200 by name and not the first 200 the disk
 * gave; past this a listing is cut, and `truncated` asks the person to type more.
 */
export const MAX_BROWSE_SCAN = 5000;
/** `lstat` and `realpath` calls in flight at once while rows are checked. */
const CHECK_CONCURRENCY = 32;

/** Everything a browse needs besides the text. */
export interface FolderBrowseContext {
  /** This machine's home folder, the root and the bound. */
  home: string;
  /** The bridge's state folder and config folder (`filesPrivateFolders` in bridge/server.ts). */
  privateFolders: readonly string[];
  host?: Host;
}

/** Run `fn` over `items`, at most `limit` at once, keeping order. */
async function mapLimited<T, U>(items: readonly T[], limit: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const out: U[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** By name case-insensitive, then by exact name, so the order is total. */
function byName(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whether anything at all sits at `path`, a dangling link included. */
async function present(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/**
 * The browse answer for `asked`, an ABSOLUTE path the New page's resolver already produced from the
 * field's text (home when the text was empty). `unknown-path` for every refusal (see the header).
 */
export async function browseFolders(ctx: FolderBrowseContext, asked: string): Promise<FilesResult<FolderBrowseResponse>> {
  const host = ctx.host ?? HOST;
  if (!isAbsoluteFolder(ctx.home, host) || !isAbsoluteFolder(asked, host)) return UNKNOWN_PATH;
  try {
    const homeReal = await realpathOf(ctx.home).catch(() => null);
    if (homeReal === null || splitPath(host, homeReal).parts.length === 0) return UNKNOWN_PATH;
    const homeSt = await stat(homeReal).catch(() => null);
    if (homeSt === null || !homeSt.isDirectory()) return UNKNOWN_PATH;

    // Under home as written: home as given first, then its real path (Fedora Atomic's `/home` is a
    // link to `/var/home`, so a text may carry either spelling). The answer keeps that spelling.
    const target = host.path.normalize(asked);
    const base = isInside(host, target, ctx.home) ? ctx.home : isInside(host, target, homeReal) ? homeReal : null;
    if (base === null) return UNKNOWN_PATH;
    const segments = splitPath(host, target).parts.slice(splitPath(host, base).parts.length);
    if (segments.length > 0 && parseRelPath(segments.join("/"), host) === null) return UNKNOWN_PATH;
    const denied = await deniedFolders(ctx.privateFolders);

    for (let depth = segments.length; depth >= 0; depth--) {
      const kept = segments.slice(0, depth);
      const candidate = depth === 0 ? homeReal : host.path.join(homeReal, ...kept);
      const real = await containedRealpath(candidate, homeReal, host);
      if (real === null) {
        // Absent: walk up. There but not inside home (a link out, a loop, a dangling link): refused,
        // never walked past, so a link out cannot become a listing of the folder above it either.
        if (await present(candidate)) return UNKNOWN_PATH;
        continue;
      }
      if (isDeniedPath(real, denied, host)) return UNKNOWN_PATH;
      const st = await stat(real).catch(() => null);
      // A file named in the text is not a folder: walk up, and its name joins the filter.
      if (st === null || !st.isDirectory()) continue;
      const path = depth === 0 ? base : host.path.join(base, ...kept);
      const parent = depth === 0 ? null : depth === 1 ? base : host.path.join(base, ...kept.slice(0, -1));
      const filter = segments.slice(depth).join("/");
      const { folders, truncated } = await listFolders(real, filter, homeReal, denied, host);
      return { path, parent, folders, filter, truncated };
    }
    return UNKNOWN_PATH;
  } catch {
    return UNKNOWN_PATH;
  }
}

/** One entry the directory read kept, before the link and git checks. */
interface Candidate {
  name: string;
  link: boolean;
}

/**
 * The sub-folders of `real` (a real path inside home) whose names start with `filter`, by name. One
 * streamed directory read that stops past {@link MAX_BROWSE_SCAN} matches, a `realpath` per link,
 * and one `lstat` per shown row for its git bit. No walk.
 */
async function listFolders(
  real: string,
  filter: string,
  homeReal: string,
  denied: readonly string[],
  host: Host,
): Promise<{ folders: FolderBrowseEntry[]; truncated: boolean }> {
  const needle = filter.toLowerCase();
  const dots = filter.startsWith(".");
  const fold = foldingHost(host);
  const keep = (name: string): boolean =>
    name.toLowerCase().startsWith(needle) &&
    (dots || !name.startsWith(".")) &&
    !isGitSegment(name) &&
    !isStateSecretName(name) &&
    !denied.some((folder) => isInside(fold, host.path.join(real, name), folder));

  const found: Candidate[] = [];
  let more = false;
  const handle = await opendir(real);
  try {
    let entry: Dirent | null;
    while ((entry = await handle.read()) !== null) {
      // A plain file, socket or device is never a folder; a link is resolved below; an entry whose
      // type the disk did not report (DT_UNKNOWN) is asked once, as a link is.
      const isDir = entry.isDirectory();
      if (!isDir && (entry.isFile() || entry.isFIFO() || entry.isSocket() || entry.isBlockDevice() || entry.isCharacterDevice())) continue;
      if (!keep(entry.name)) continue;
      if (found.length >= MAX_BROWSE_SCAN) {
        more = true;
        break;
      }
      found.push({ name: entry.name, link: !isDir });
    }
  } finally {
    await handle.close().catch(() => {});
  }

  // A link (or an untyped entry) counts only when it resolves to a folder inside home that is not
  // denied. Its git bit is read off the real folder.
  const resolved = await mapLimited(found, CHECK_CONCURRENCY, async (c): Promise<{ name: string; dir: string } | null> => {
    const at = host.path.join(real, c.name);
    if (!c.link) return { name: c.name, dir: at };
    const target = await containedRealpath(at, homeReal, host).catch(() => null);
    if (target === null || isDeniedPath(target, denied, host)) return null;
    const st = await stat(target).catch(() => null);
    return st !== null && st.isDirectory() ? { name: c.name, dir: target } : null;
  });
  const folders = resolved.filter((r): r is { name: string; dir: string } => r !== null).toSorted((a, b) => byName(a.name, b.name));
  const shown = folders.slice(0, MAX_BROWSE_FOLDERS);
  const rows = await mapLimited(shown, CHECK_CONCURRENCY, async (f): Promise<FolderBrowseEntry> => ({
    name: f.name,
    git: await present(host.path.join(f.dir, ".git")),
  }));
  return { folders: rows, truncated: more || folders.length > MAX_BROWSE_FOLDERS };
}

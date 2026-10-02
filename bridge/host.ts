// THE HOST: ONE OBJECT FOR EVERY PLATFORM FACT A PATH OR A BINARY NAME DEPENDS ON (M43 spec 11).
//
// Code that behaves differently per platform used to take a `platform` string in one place, a
// `PathApi` in another and a literal `"collie"` in a third. The three could disagree (`platform:
// "win32"` with `path.posix`), and a test then passed for the wrong reason. Now one `Host` carries
// all of it, so a later change to platform behaviour is one edit here.
//
// A test pins a flavour with `hostFor("win32")`, so the Windows branch runs on Linux CI. That proves
// the logic, not Windows: no spawn, no `.exe` lookup, no file lock. Production reads `HOST`.
//
// When to use which: production code reads `HOST` once, at the edge, and passes the object down as
// `host`. Everything below takes it as a parameter, so a test can pin one. A pinned host changes the
// string rules only: do not hand its paths to a real file call, because the machine's own `join`
// and the pinned `host.path` then mix separators.
//
// `caseInsensitive` is true only for win32. macOS disks fold case too, but the checks never did, and
// this change keeps every Linux and macOS answer as it was. A fold here is `toLowerCase`, which is
// not NTFS's own rule for every character; it is a stable choice with that limit.
//
// Not here: the release artifact id (`linux-x64`, `macos-arm64`). That names a download, not the OS
// the process runs on, and `cli/update.ts`'s `platformId` owns it.

import nodePath from "node:path";

/**
 * The `node:path` flavour a rule reads paths with. Native by default; a test pins `path.win32` (or
 * `path.posix`) so the Windows branch runs on Linux CI.
 */
export type PathApi = typeof nodePath;

export interface Host {
  readonly platform: NodeJS.Platform;
  /** The path rules of this host: `path.win32` on Windows, `path.posix` everywhere else. */
  readonly path: PathApi;
  /** The suffix of an executable file name: `.exe` on Windows, nothing elsewhere. */
  readonly exeSuffix: "" | ".exe";
  /**
   * Whether two spellings that differ only in case name the same file. Today only Windows folds case,
   * though macOS disks are case-insensitive too: the checks keep their old answer there.
   */
  readonly caseInsensitive: boolean;
}

const built = new Map<string, Host>();

/**
 * The host for a platform name. `win32` reads Windows paths, any other name reads POSIX paths and
 * keeps its own `platform` (a test asks for `darwin` to reach the launchd branch). Built once per
 * name, so the same call returns the same object.
 */
export function hostFor(platform: NodeJS.Platform | string): Host {
  const known = built.get(platform);
  if (known !== undefined) return known;
  const win = platform === "win32";
  // SAFETY: `NodeJS.Platform` is a union of platform name strings. A name outside it is the POSIX
  // branch below and nothing reads it except an equality test, so the widening cannot misroute.
  // Frozen: one test that changed a host would change it for every later test.
  const host: Host = Object.freeze({
    platform: platform as NodeJS.Platform,
    path: win ? nodePath.win32 : nodePath.posix,
    exeSuffix: win ? ".exe" : "",
    caseInsensitive: win,
  });
  built.set(platform, host);
  return host;
}

/** The machine this process runs on. The default wherever a host is injected. */
export const HOST: Host = hostFor(process.platform);

// ── The one place a collie binary file name is written ───────────────────────

/** `collie`, or `collie.exe` on Windows. */
export function binaryName(host: Host): string {
  return `collie${host.exeSuffix}`;
}

/** `<root>/bin/collie` for this host. */
export function collieBinary(root: string, host: Host = HOST): string {
  return host.path.join(root, "bin", binaryName(host));
}

// ── Where a path sits ────────────────────────────────────────────────────────

/** A path cut into its root (`/`, `C:\`, `\\srv\share\`) and its folder names. */
export interface SplitPath {
  root: string;
  parts: string[];
}

/** Windows spells a name in any case, and a drive letter or share the same way. POSIX is exact. */
export const foldName = (host: Host, name: string): string => (host.caseInsensitive ? name.toLowerCase() : name);

/** `\\?\C:\x` is `C:\x` and `\\?\UNC\srv\share` is `\\srv\share`: same place, a spelling the checks do not know. */
export function dropExtendedPrefix(path: string): string {
  if (/^\\\\\?\\UNC\\/i.test(path)) return `\\\\${path.slice(8)}`;
  return path.startsWith("\\\\?\\") ? path.slice(4) : path;
}

export function splitPath(host: Host, path: string): SplitPath {
  const win = host.platform === "win32";
  const plain = win ? dropExtendedPrefix(path) : path;
  const root = host.path.parse(plain).root;
  const parts = plain.slice(root.length).split(win ? /[\\/]+/ : /\/+/).filter(Boolean);
  return { root: win ? root.replaceAll("/", "\\") : root, parts };
}

/**
 * Whether `folder` is `parent` or sits anywhere below it. By folder names, so `/a/ab` is not inside
 * `/a/a`, and on Windows by case-folded names, so `c:\users\pat` is inside `C:\Users\Pat`. A path on
 * another drive or share is never inside. Pure: neither path has to exist, and neither is resolved,
 * so a `..` segment counts as a name. Argument order: the folder first, the parent second, so
 * `isInside(host, "/a/b/c", "/a/b")` is true and the swapped call is false.
 */
export function isInside(host: Host, folder: string, parent: string): boolean {
  const child = splitPath(host, folder);
  const above = splitPath(host, parent);
  if (foldName(host, child.root) !== foldName(host, above.root)) return false;
  if (above.parts.length > child.parts.length) return false;
  return above.parts.every((name, i) => foldName(host, name) === foldName(host, child.parts[i]!));
}

/** `child` is `parent` or below it. {@link isInside} with the arguments the other way round. */
export function isSameOrInside(host: Host, parent: string, child: string): boolean {
  return isInside(host, child, parent);
}

/** `child` is strictly below `parent`: not the same folder. */
export function isBelow(host: Host, parent: string, child: string): boolean {
  return isInside(host, child, parent) && splitPath(host, child).parts.length > splitPath(host, parent).parts.length;
}

import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ErrorCode } from "./error-codes.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import { isValidWorktreeBranch } from "./worktree-branch.ts";

// ── Where a new branch's folder goes (ADR 0093) ──────────────────────────────────────────────────
//
// Herdr 0.9.3 takes `path` on `worktree.create` (`herdr worktree create --path`), so the New sheet can
// put a branch's folder somewhere other than Herdr's own directory and it still is a Herdr worktree.
// The phone names a PARENT folder (from Recent and Favourites, or typed), never the folder itself, and
// this module names the child after the branch. It is the one place a client-supplied value becomes a
// folder Collie asks to be CREATED, so the rule is narrow and runs on every use, never cached:
//
//   1. a string with no control character, at most {@link MAX_PARENT_CHARS}; a leading `~` is home;
//   2. absolute, and no `..` segment in what was sent (refused, not resolved);
//   3. it exists and is a directory, read through `realpath`;
//   4. no link anywhere below home: the real path must equal the path as written, with home itself
//      allowed to be a link (Fedora Atomic's `/home` → `/var/home`);
//   5. under the home dir, and no segment below home starts with `.`, which keeps out every dotdir
//      and every `.git`;
//   6. not inside the repo's own folder, so the new checkout never shows as untracked files in the
//      one it was cut from;
//   7. the child (Herdr's slug of the branch) must not exist, checked with `lstat` so a dangling link
//      counts as existing.
//
// Git and Herdr are only ever reached with argv (`bridge/mux/herdr/client.ts` sends JSON over the
// socket), so the path is a value, never part of a shell line. The rule runs again inside the create,
// immediately before the multiplexer is asked: what the phone was shown is a preview, not a promise.
//
// ── HERDR'S DEFAULT ──────────────────────────────────────────────────────────────────────────────
// "Herdr's default" sends NO path, so Herdr decides. The sheet still shows where that will be, from
// Herdr's own rule, probed on 0.9.3 (spec M48/01): `<dir>/<repo folder name>/<slug>`, where `<dir>` is
// `[worktrees] directory` in Herdr's `config.toml` (a leading `~` expanded) or `~/.herdr/worktrees`.

/** The longest parent folder string accepted. Linux's `PATH_MAX`. */
export const MAX_PARENT_CHARS = 4096;

/** Which of the two folder kinds the sheet picked. */
export type WorktreeFolderKind = "default" | "parent";

/** The refusals, each a catalogued code (`bridge/error-codes.ts`). */
export type FolderRefusal = Extract<
  ErrorCode,
  | "worktree.folder_invalid"
  | "worktree.folder_missing"
  | "worktree.folder_link"
  | "worktree.folder_outside_home"
  | "worktree.folder_hidden"
  | "worktree.folder_in_repo"
  | "worktree.target_exists"
  | "worktree.invalid_branch"
>;

export type FolderOutcome = { ok: true; path: string } | { ok: false; code: FolderRefusal; path?: string };

/**
 * Herdr's folder name for a branch: lower case, every run of characters that are not ASCII letters
 * or digits turned into one `-`, and no `-` at either end. `feat/x-y` → `feat-x-y`. Probed on 0.9.3.
 */
export function branchSlug(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

/** Whether `text` carries an ASCII control character. */
function hasControlChar(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** `~` and `~/x` against `home`; anything else unchanged. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || (sep === "\\" && path.startsWith("~\\"))) return join(home, path.slice(2));
  return path;
}

/** Whether `child` is `parent` or sits under it, on whole segments. */
export function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** The file calls the rule makes, injected so the tests drive every branch on a temp dir. */
export interface FolderFs {
  realpath(path: string): Promise<string>;
  /** `true` for a directory, following links; throws when nothing is there. */
  isDirectory(path: string): Promise<boolean>;
  /** Whether anything (a link included, dangling or not) sits at `path`. */
  exists(path: string): Promise<boolean>;
}

export const diskFolderFs: FolderFs = {
  realpath: (path) => realpath(path),
  isDirectory: async (path) => (await stat(path)).isDirectory(),
  exists: async (path) => {
    try {
      await lstat(path);
      return true;
    } catch {
      return false;
    }
  },
};

export interface ParentRequest {
  /** The parent folder as the phone sent it. */
  parent: string;
  /** The branch, already checked by {@link isValidWorktreeBranch}. */
  branch: string;
  /** The repo's main folder, as a real path. */
  repoRoot: string;
  home?: string;
  fs?: FolderFs;
}

/**
 * The folder a new branch goes in under `parent`, or the refusal that stops it. Runs the whole rule
 * from the header, in order, and touches nothing on disk but reads.
 */
export async function resolveParentTarget(req: ParentRequest): Promise<FolderOutcome> {
  const fs = req.fs ?? diskFolderFs;
  const home = req.home ?? homedir();
  const raw = req.parent.trim();
  // 1, 2: the string itself.
  if (raw === "" || raw.length > MAX_PARENT_CHARS || hasControlChar(raw)) return { ok: false, code: "worktree.folder_invalid" };
  if (!isValidWorktreeBranch(req.branch)) return { ok: false, code: "worktree.invalid_branch" };
  const slug = branchSlug(req.branch);
  if (slug === "") return { ok: false, code: "worktree.invalid_branch" };
  // On the string as SENT: `join` inside `expandHome` would quietly resolve a `..` away.
  if (raw.split(/[\\/]+/u).includes("..")) return { ok: false, code: "worktree.folder_invalid" };
  const expanded = expandHome(raw, home);
  if (!isAbsolute(expanded)) return { ok: false, code: "worktree.folder_invalid" };

  // 3: there, and a directory.
  let real: string;
  let realHome: string;
  try {
    real = await fs.realpath(expanded);
    if (!(await fs.isDirectory(real))) return { ok: false, code: "worktree.folder_missing" };
    realHome = await fs.realpath(home);
  } catch {
    return { ok: false, code: "worktree.folder_missing" };
  }

  // 4: no link below home. The path as written, with home's own spelling swapped for its real one,
  // must be the real path. A link above home (home itself) is the operator's machine, not the request.
  const lexical = resolve(expanded);
  const asWritten = isWithin(lexical, home) ? join(realHome, relative(home, lexical)) : lexical;
  // 5: under home first, so a path outside it is named for what it is rather than as a link.
  if (!isWithin(real, realHome)) return { ok: false, code: "worktree.folder_outside_home" };
  if (asWritten !== real) return { ok: false, code: "worktree.folder_link" };
  const below = relative(realHome, real);
  if (below !== "" && below.split(sep).some((segment) => segment.startsWith("."))) {
    return { ok: false, code: "worktree.folder_hidden" };
  }

  // 6: not inside the repo it branches from.
  if (isWithin(real, req.repoRoot)) return { ok: false, code: "worktree.folder_in_repo" };

  // 7: the child must not be there yet.
  const target = join(real, slug);
  if (await fs.exists(target)) return { ok: false, code: "worktree.target_exists", path: target };
  return { ok: true, path: target };
}

/** Reads Herdr's `config.toml`, or `null` when there is none to read. Injected for the tests. */
export type HerdrConfigRead = () => Promise<string | null>;

/** Herdr's own config file: `$XDG_CONFIG_HOME/herdr/config.toml`, else `~/.config/herdr/config.toml`. */
export function herdrConfigPath(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, ".config");
  return join(base, "herdr", "config.toml");
}

export const readHerdrConfig: HerdrConfigRead = async () => {
  try {
    return await readFile(herdrConfigPath(), "utf8");
  } catch {
    return null;
  }
};

/**
 * Herdr's worktree directory: `[worktrees] directory` from its config, a leading `~` expanded, else
 * `~/.herdr/worktrees`. A config that does not parse, or a value that is not an absolute path after
 * expansion, is read as no setting, which is what Herdr's own `config check` does with a bad key.
 */
export function herdrWorktreeDir(configText: string | null, home: string): string {
  const fallback = join(home, ".herdr", "worktrees");
  if (configText === null) return fallback;
  try {
    // SAFETY: `Bun.TOML.parse` answers a parsed document of tables, arrays and scalars; nothing is
    // believed about it here but what the two field reads below check, one `typeof` each.
    const doc = Bun.TOML.parse(configText) as JsonValue;
    const section = tableOf(doc)?.worktrees;
    const dir = section === undefined ? undefined : tableOf(section)?.directory;
    if (typeof dir !== "string" || dir.trim() === "") return fallback;
    const expanded = expandHome(dir.trim(), home);
    return isAbsolute(expanded) ? expanded : fallback;
  } catch {
    return fallback;
  }
}

/** A TOML table as a record, or `null` for any other value. */
function tableOf(value: JsonValue): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

/** Where Herdr will put the branch when no `path` is sent. A prediction, shown before Start. */
export async function herdrDefaultTarget(
  repoRoot: string,
  branch: string,
  home: string = homedir(),
  read: HerdrConfigRead = readHerdrConfig,
): Promise<string> {
  return join(herdrWorktreeDir(await read(), home), basename(repoRoot), branchSlug(branch));
}

/**
 * The repo a folder belongs to, read from the disk alone: the nearest folder at or above `folder`
 * holding a `.git`. `null` when there is none below the filesystem root. The caller hands the answer
 * to git (`--git-common-dir`) to reach the MAIN checkout of a linked worktree.
 */
export async function nearestWorkTree(folder: string, fs: Pick<FolderFs, "exists"> = diskFolderFs): Promise<string | null> {
  let at = folder;
  // Bounded by the root: `dirname("/")` is "/" and the loop stops there.
  for (let depth = 0; depth < 256; depth++) {
    if (await fs.exists(join(at, ".git"))) return at;
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
  return null;
}

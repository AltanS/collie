import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ErrorCode } from "./error-codes.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import { isValidWorktreeBranch } from "./worktree-branch.ts";
// A cycle by name only: worktree-add.ts reads Herdr's default folder from here, and each side calls
// the other inside a function body, never while the module loads.
import { targetExistsDetail, worktreeMatchOf } from "./worktree-add.ts";

// ── Where a new branch's folder goes (ADR 0093) ──────────────────────────────────────────────────
//
// The bridge makes the worktree with git (`bridge/worktree-add.ts`, ADR 0126) and opens the folder as a
// space, so the New sheet can put a branch's folder anywhere this rule allows. The phone names a PARENT folder (from Recent and Favourites, or typed), never the folder itself, and
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
//      The one exception is a child that already is the SAME worktree of this repo, finished, on the
//      branch asked for, reached through no link: a half-done create left it, and the create then only
//      opens it (M81). Any other entry git lists there is refused with a sentence naming its state,
//      the same answer `addWorktree` gives for Herdr's default folder (`worktreeMatchOf`).
//
// Git is only ever reached with argv (`runGit`, bridge/changes.ts), so the path is a value, never part
// of a shell line. The rule runs again inside the create, immediately before `git worktree add`: what
// the phone was shown is a preview, not a promise.
//
// ── HERDR'S DEFAULT ──────────────────────────────────────────────────────────────────────────────
// "Herdr's default" sends NO path, and the bridge chooses the folder itself (`herdrDefaultTarget`). It
// follows Herdr's own rule, probed on 0.9.3 (spec M48/01), so a checkout made here lands where one made
// by Herdr did: `<dir>/<repo folder name>/<slug>`, where `<dir>` is `[worktrees] directory` in Herdr's
// `config.toml` (a leading `~` expanded) or `~/.herdr/worktrees`.

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

/**
 * The folder, or the refusal. `detail` is one plain sentence, set only on a `worktree.target_exists`
 * for a folder git lists as a worktree in another state ("that folder holds branch x").
 */
export type FolderOutcome = { ok: true; path: string } | { ok: false; code: FolderRefusal; path?: string; detail?: string };

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
  /** Makes the folder and its parents with `mode`; no error when it is already a folder. Rejects when `path` is not one. */
  makeDir(path: string, mode: number): Promise<void>;
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
  makeDir: async (path, mode) => {
    // A recursive mkdir answers EEXIST for a file in the way, and nothing for a folder already there.
    await mkdir(path, { recursive: true, mode });
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
  if (!isValidWorktreeBranch(req.branch)) return { ok: false, code: "worktree.invalid_branch" };
  const slug = branchSlug(req.branch);
  if (slug === "") return { ok: false, code: "worktree.invalid_branch" };
  // 1 to 5: the parent itself. The string check comes first, so a bad string is named before a bad branch.
  const parent = await checkedParentDir(req.parent, req.home, fs);
  if (!parent.ok) return parent;
  const real = parent.path;

  // 6: not inside the repo it branches from.
  if (isWithin(real, req.repoRoot)) return { ok: false, code: "worktree.folder_in_repo" };

  // 7: the child must not be there yet, unless it is the same worktree of THIS repo, finished, that a
  // half-done create left behind (the checkout was made, the space did not open). That one is no
  // link, git's own list names it on the branch asked for, and the create then only opens it
  // (bridge/worktree-add.ts, `existed`).
  const target = join(real, slug);
  if (await fs.exists(target)) return ownWorktreeVerdict(target, req.repoRoot, req.branch, fs);
  return { ok: true, path: target };
}

/**
 * Rules 1 to 5 on a parent folder alone, no branch and no repo: the real path of a folder that is a
 * string with no control character, absolute with no `..`, there and a directory, with no link
 * below home, under home, and no hidden segment. The setting "Worktree folder" is checked with
 * exactly this when it is saved and again on every create and plan that uses it.
 */
export async function checkedParentDir(
  parent: string,
  homeDir?: string,
  fs: FolderFs = diskFolderFs,
): Promise<{ ok: true; path: string } | { ok: false; code: FolderRefusal }> {
  const home = homeDir ?? homedir();
  const raw = parent.trim();
  // 1, 2: the string itself.
  if (raw === "" || raw.length > MAX_PARENT_CHARS || hasControlChar(raw)) return { ok: false, code: "worktree.folder_invalid" };
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
  return { ok: true, path: real };
}

export interface SetFolderRequest {
  /** The setting's value as stored: the parent directory, a leading `~` allowed. */
  dir: string;
  branch: string;
  /** The repo's main folder, as a real path. */
  repoRoot: string;
  home?: string;
  fs?: FolderFs;
}

/**
 * Where the setting "Worktree folder" puts a branch: `<dir>/<repo folder name>/<slug>`, Herdr's own
 * shape, so two repos never collide (ADR 0093, note of 2026-11-13). The directory passes rules 1 to 5
 * and 6 (not inside the repo); the repo's folder under it may not exist yet, and if it does it must be
 * a real directory, no link, because git creates it otherwise; the child is rule 7. Reads only.
 */
export async function resolveSetFolderTarget(req: SetFolderRequest): Promise<FolderOutcome> {
  const fs = req.fs ?? diskFolderFs;
  if (!isValidWorktreeBranch(req.branch)) return { ok: false, code: "worktree.invalid_branch" };
  const slug = branchSlug(req.branch);
  if (slug === "") return { ok: false, code: "worktree.invalid_branch" };
  const dir = await checkedParentDir(req.dir, req.home, fs);
  if (!dir.ok) return dir;
  if (isWithin(dir.path, req.repoRoot)) return { ok: false, code: "worktree.folder_in_repo" };
  const repoDir = join(dir.path, basename(req.repoRoot));
  if (await fs.exists(repoDir)) {
    try {
      if ((await fs.realpath(repoDir)) !== repoDir || !(await fs.isDirectory(repoDir))) return { ok: false, code: "worktree.folder_link", path: repoDir };
    } catch {
      return { ok: false, code: "worktree.folder_link", path: repoDir };
    }
  }
  const target = join(repoDir, slug);
  if (await fs.exists(target)) return ownWorktreeVerdict(target, req.repoRoot, req.branch, fs);
  return { ok: true, path: target };
}

/**
 * The verdict on a `target` that exists: accepted when it is the same finished worktree of `repoRoot`
 * on `branch`, reached through no link; refused otherwise, with git's state named when it lists one.
 */
async function ownWorktreeVerdict(target: string, repoRoot: string, branch: string, fs: FolderFs): Promise<FolderOutcome> {
  const refusal: FolderOutcome = { ok: false, code: "worktree.target_exists", path: target };
  try {
    if ((await fs.realpath(target)) !== target) return refusal;
  } catch {
    return refusal;
  }
  const match = await worktreeMatchOf(repoRoot, target, branch);
  if (match === null || match.kind === "absent") return refusal;
  if (match.kind === "same") return { ok: true, path: target };
  return { ...refusal, detail: targetExistsDetail(match) };
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

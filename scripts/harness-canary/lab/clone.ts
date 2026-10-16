// The repo a pass commit branches from (M56 spec 10). The lab never writes into a repo it is given.
// It keeps a clone of its own under `<lab root>/clone`, made from the given repo's origin URL on first use
// and reset to `origin/main` before each pass commit. The pass branch and the scratch worktree come from
// that clone, so a person's checkout never gets a branch, a worktree or a changed file from the lab.
//
// The given repo is refused when it lies under `~/apps` (a live lane runs from there) or when its HEAD is
// detached (a detached checkout is the one an update left on a tag, and it may be a live lane too).

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { realGit, type Git } from "./publish";

export const LAB_DIR_ENV = "COLLIE_HARNESS_LAB_DIR";

/** `~/.cache/collie-lab/harness-lab`, or the folder `COLLIE_HARNESS_LAB_DIR` names. */
export function defaultLabRoot(env: Readonly<Record<string, string | undefined>> = process.env, home: string = homedir()): string {
  const named = env[LAB_DIR_ENV];
  return named !== undefined && named !== "" ? named : join(home, ".cache", "collie-lab", "harness-lab");
}

export const cloneDirOf = (labRoot: string): string => join(labRoot, "clone");

/** Whether the lab's clone holds the branch a pass left. */
export function branchInClone(branch: string, labRoot: string = defaultLabRoot(), git: Git = realGit): boolean {
  const dir = cloneDirOf(labRoot);
  return existsSync(join(dir, ".git")) && git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0;
}

/** Throws when the repo may not be the lab's source. Returns its origin URL. */
export function checkSource(repo: string, home: string = homedir(), git: Git = realGit): string {
  let real = repo;
  try {
    real = realpathSync(repo);
  } catch {
    throw new Error(`the repo ${repo} does not exist`);
  }
  const apps = join(realpathOr(home), "apps") + sep;
  if (`${real}${sep}`.startsWith(apps)) throw new Error(`the repo ${repo} is under ${join(home, "apps")}: a live lane may run from there, so the lab refuses it`);
  const head = git(real, ["symbolic-ref", "--quiet", "HEAD"]);
  if (head.code !== 0) throw new Error(`the repo ${repo} has a detached HEAD: the lab refuses it`);
  const origin = git(real, ["remote", "get-url", "origin"]);
  const url = origin.stdout.trim();
  if (origin.code !== 0 || url === "") throw new Error(`the repo ${repo} has no origin remote to clone from`);
  return url;
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function must(result: { code: number; stderr: string }, what: string): void {
  if (result.code !== 0) throw new Error(`git ${what} failed (${String(result.code)}): ${result.stderr.trim()}`);
}

/** The lab's clone, made on first use and reset to origin/main now. Returns its path. */
export function ensureClone(source: string, labRoot: string, home: string = homedir(), git: Git = realGit): string {
  const url = checkSource(source, home, git);
  const dir = cloneDirOf(labRoot);
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(labRoot, { recursive: true });
    must(git(labRoot, ["clone", "--quiet", url, dir]), "clone");
  } else if (git(dir, ["remote", "get-url", "origin"]).stdout.trim() !== url) {
    must(git(dir, ["remote", "set-url", "origin", url]), "remote set-url");
  }
  must(git(dir, ["fetch", "--quiet", "--prune", "origin"]), "fetch");
  must(git(dir, ["worktree", "prune"]), "worktree prune");
  must(git(dir, ["checkout", "--quiet", "--force", "-B", "main", "origin/main"]), "checkout main");
  must(git(dir, ["clean", "--quiet", "-fdx"]), "clean");
  return dir;
}

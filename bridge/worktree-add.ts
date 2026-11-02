// A NEW WORKTREE, MADE BY COLLIE WITH GIT (M81 spec 02).
//
// A worktree is plain git on disk, so the bridge makes it itself, and the multiplexer is asked only to
// open the folder as a space (`createSpace`). That is what lets "New worktree" work on every
// multiplexer that opens a space, the Herdr core included, instead of only on the old Herdr daemon.
//
// ── THE FOLDER STAYS HERDR'S ───────────────────────────────────────────────────────────────────────
// With no `path` the checkout goes where Herdr would put it (`herdrDefaultTarget`), so the plan's
// `defaultTarget` and every checkout made before this module agree on one folder.
//
// ── A HALF-DONE CREATE IS RECOVERED HERE ───────────────────────────────────────────────────────────
// The old daemon create was not atomic: a checkout could exist with no space showing it, and a retry
// then failed because the path was taken. Here a retry asks git first (`worktree list --porcelain`):
// when the folder already is a linked worktree of this repo, the answer is `existed: true` and `add`
// does not run, so the caller only opens it.
//
// ── GIT RUNS HARDENED, ARGV ONLY ───────────────────────────────────────────────────────────────────
// Through `runGit` (bridge/changes.ts): no shell, no string built into a command, the bridge's own
// `-c` hardening (no hooks, no transport, no credential helper) and a clean environment. The branch
// and base were checked by the route before this is reached, and `--` keeps the path a path.

import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { gitBinary, runGit, type RepoDirs } from "./changes.ts";
import type { ErrorCode } from "./error-codes.ts";
import { herdrDefaultTarget, readHerdrConfig, type HerdrConfigRead } from "./worktree-folder.ts";

/** How long one `git worktree add` may run. A large checkout writes many files. */
export const WORKTREE_ADD_TIMEOUT_MS = 60_000;

/** How much of git's output is kept, stdout and stderr each. */
export const WORKTREE_ADD_MAX_BYTES = 64 * 1024;

/** How long the `worktree list` read before an add may run. */
const WORKTREE_LIST_TIMEOUT_MS = 10_000;

/** What `addWorktree` reaches beyond its request. Every field defaults for production. */
export interface WorktreeAddDeps {
  /** The git binary, or `null` for none. Defaults to {@link gitBinary}. */
  git?: string | null;
  home?: string;
  readHerdrConfig?: HerdrConfigRead;
}

/** One new worktree: a new branch, in a new folder, cut from `base` or from the repo's HEAD. */
export interface WorktreeAddRequest {
  /** The repo's main checkout, as a real path. */
  repoRoot: string;
  /** The new branch. Already checked by the route (`isValidWorktreeBranch`, `check-ref-format`). */
  branch: string;
  /** The starting point, already resolved to a ref that names a commit. Absent is the repo's HEAD. */
  base?: string;
  /** The folder, already checked by the folder rule. Absent is Herdr's default folder for the branch. */
  path?: string;
}

/** The checkout's folder, and whether it was there already as a worktree of this repo. */
export type WorktreeAddOutcome =
  | { ok: true; path: string; existed: boolean }
  | { ok: false; code: Extract<ErrorCode, "worktree.create_failed">; detail: string };

/** Make the worktree, or find the one a half-done create left. Never throws. */
export async function addWorktree(deps: WorktreeAddDeps, request: WorktreeAddRequest): Promise<WorktreeAddOutcome> {
  const git = deps.git === undefined ? await gitBinary() : deps.git;
  if (git === null) return refused("git was not found on this machine");
  const path =
    request.path ??
    (await herdrDefaultTarget(request.repoRoot, request.branch, deps.home ?? homedir(), deps.readHerdrConfig ?? readHerdrConfig));
  const repo: RepoDirs = { workTree: request.repoRoot, gitDir: join(request.repoRoot, ".git") };

  const linked = await isLinkedWorktree(git, repo, path);
  if (linked === null) return refused("git could not list the worktrees of this repo");
  if (linked) return { ok: true, path, existed: true };

  const args = ["worktree", "add", "--quiet", "-b", request.branch, "--", path];
  if (request.base !== undefined) args.push(request.base);
  const run = await runGit(git, repo, args, [], WORKTREE_ADD_MAX_BYTES, {
    timeoutMs: WORKTREE_ADD_TIMEOUT_MS,
    captureStderr: true,
  });
  if (run.timedOut) return refused(`git worktree add did not finish within ${String(WORKTREE_ADD_TIMEOUT_MS / 1000)} s`);
  if (run.code !== 0) return refused(firstSentence(run.stderr ?? "") ?? `git worktree add exited with ${String(run.code)}`);
  return { ok: true, path, existed: false };
}

function refused(detail: string): WorktreeAddOutcome {
  return { ok: false, code: "worktree.create_failed", detail };
}

/**
 * Whether `path` is a linked worktree of `repo` today, by git's own list. `null` when git could not
 * answer. A folder that is not on disk is not one, whatever git still has registered for it.
 */
async function isLinkedWorktree(git: string, repo: RepoDirs, path: string): Promise<boolean | null> {
  const target = await realOrNull(path);
  if (target === null) return false;
  const run = await runGit(git, repo, ["worktree", "list", "--porcelain"], [], WORKTREE_ADD_MAX_BYTES, {
    timeoutMs: WORKTREE_LIST_TIMEOUT_MS,
  });
  if (run.code !== 0 || run.timedOut || run.capped) return null;
  const main = await realOrNull(repo.workTree);
  for (const listed of worktreePaths(run.stdout.toString("utf8"))) {
    const real = await realOrNull(listed);
    if (real === target && real !== main) return true;
  }
  return false;
}

/** Every `worktree <path>` line of `git worktree list --porcelain`, in order. */
export function worktreePaths(porcelain: string): string[] {
  const prefix = "worktree ";
  return porcelain
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

/** Git's failure sentence: the first line that says something, with its `fatal:` or `error:` tag off. */
export function firstSentence(stderr: string): string | null {
  const line = stderr
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (line === undefined) return null;
  return line.replace(/^(?:fatal|error):\s*/u, "");
}

async function realOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

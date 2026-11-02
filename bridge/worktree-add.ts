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
// when the folder already is the SAME worktree, finished, the answer is `existed: true` and `add`
// does not run, so the caller only opens it. "The same, finished" is strict (`worktreeMatchOf`): a
// linked worktree of this repo, on the requested branch, and neither locked (git locks an entry
// "initializing" until the checkout is written, and a kill leaves the lock), prunable nor bare. Any
// other entry at that folder is `worktree.target_exists`, with a sentence that names its state.
//
// ── ONE CREATE PER FOLDER AT A TIME ────────────────────────────────────────────────────────────────
// Receipts join two requests with ONE request id (worktree-receipts.ts). Two ids for one folder are
// held here: a second create for a folder with one in flight waits for it, then asks git again.
//
// ── A TIMEOUT CLEANS UP ITS OWN HALF ───────────────────────────────────────────────────────────────
// A `worktree add` killed at the timeout leaves a registered, locked, half-written checkout. When the
// folder was not there before this call, it is removed again (`worktree remove`, forced twice, which
// is what a locked entry needs), so a retry starts clean. A folder that was there before is never
// touched.
//
// ── GIT RUNS HARDENED, ARGV ONLY ───────────────────────────────────────────────────────────────────
// Through `runGit` (bridge/changes.ts): no shell, no string built into a command, the bridge's own
// `-c` hardening (no hooks, no transport, no credential helper) and a clean environment. The branch
// and base were checked by the route before this is reached, and `--` keeps the path a path.

import { lstat, realpath } from "node:fs/promises";
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

/** How long the cleanup of a checkout a timed-out add left may run. */
const WORKTREE_REMOVE_TIMEOUT_MS = 15_000;

/** What `addWorktree` reaches beyond its request. Every field defaults for production. */
export interface WorktreeAddDeps {
  /** The git binary, or `null` for none. Defaults to {@link gitBinary}. */
  git?: string | null;
  home?: string;
  readHerdrConfig?: HerdrConfigRead;
  /** How long `git worktree add` may run. Defaults to {@link WORKTREE_ADD_TIMEOUT_MS}; a test shortens it. */
  timeoutMs?: number;
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

/** The checkout's folder, and whether it was there already as the same worktree of this repo. */
export type WorktreeAddOutcome =
  | { ok: true; path: string; existed: boolean }
  | { ok: false; code: Extract<ErrorCode, "worktree.create_failed">; detail: string }
  | { ok: false; code: Extract<ErrorCode, "worktree.target_exists">; detail: string; path: string };

/**
 * The creates running now, by target folder as given. Per bridge process: one `git worktree add` for
 * one folder at a time, whatever request id each create carries.
 */
const inFlight = new Map<string, Promise<WorktreeAddOutcome>>();

/** Make the worktree, or find the one a half-done create left. Never throws. */
export async function addWorktree(deps: WorktreeAddDeps, request: WorktreeAddRequest): Promise<WorktreeAddOutcome> {
  const git = deps.git === undefined ? await gitBinary() : deps.git;
  if (git === null) return refused("git was not found on this machine");
  const path =
    request.path ??
    (await herdrDefaultTarget(request.repoRoot, request.branch, deps.home ?? homedir(), deps.readHerdrConfig ?? readHerdrConfig));
  const repo: RepoDirs = { workTree: request.repoRoot, gitDir: join(request.repoRoot, ".git") };

  // No await between the read and the write of the map, so two creates cannot both start one.
  const running = inFlight.get(path);
  if (running !== undefined) return afterRunning(running, git, repo, path, request.branch);
  const work = createAt(git, repo, path, request, deps.timeoutMs ?? WORKTREE_ADD_TIMEOUT_MS);
  inFlight.set(path, work);
  try {
    return await work;
  } finally {
    inFlight.delete(path);
  }
}

/**
 * The answer for a create that found another one in flight for its folder: wait for it, then ask git
 * again. The finished checkout on this branch opens; another state is refused; nothing there is the
 * first create's failure.
 */
async function afterRunning(
  running: Promise<WorktreeAddOutcome>,
  git: string,
  repo: RepoDirs,
  path: string,
  branch: string,
): Promise<WorktreeAddOutcome> {
  const first = await running;
  const match = await worktreeMatch(git, repo, path, branch);
  if (match === null) return refused("git could not list the worktrees of this repo");
  if (match.kind === "same") return { ok: true, path, existed: true };
  if (match.kind !== "absent") return targetExists(path, match);
  if (!first.ok) return first;
  return refused("the worktree another create made in that folder is gone");
}

/** The check and the add for one folder, run once at a time per folder by {@link addWorktree}. */
async function createAt(
  git: string,
  repo: RepoDirs,
  path: string,
  request: WorktreeAddRequest,
  timeoutMs: number,
): Promise<WorktreeAddOutcome> {
  const match = await worktreeMatch(git, repo, path, request.branch);
  if (match === null) return refused("git could not list the worktrees of this repo");
  if (match.kind === "same") return { ok: true, path, existed: true };
  if (match.kind !== "absent") return targetExists(path, match);

  const existedBefore = await isOnDisk(path);
  // `--no-track`: a branch cut from `origin/main` gets no upstream, so a later push names its own.
  const args = ["worktree", "add", "--quiet", "--no-track", "-b", request.branch, "--", path];
  if (request.base !== undefined) args.push(request.base);
  const run = await runGit(git, repo, args, [], WORKTREE_ADD_MAX_BYTES, { timeoutMs, captureStderr: true });
  const seconds = String(timeoutMs / 1000);
  if (run.timedOut && existedBefore) return refused(`git worktree add did not finish within ${seconds} s`);
  if (run.timedOut) {
    // Best effort, never on the `existed` path, and only on a folder this call made.
    const removed = await runGit(git, repo, ["worktree", "remove", "--force", "--force", "--", path], [], WORKTREE_ADD_MAX_BYTES, {
      timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS,
    });
    if (removed.code === 0 && !removed.timedOut) {
      // `worktree add -b` refuses an existing branch before it writes anything, so a timeout means this
      // call made the branch. Left behind, it would fail the retry with "a branch named x already
      // exists". Best effort, and only after the checkout is gone: a branch checked out still cannot go.
      const dropped = await runGit(git, repo, ["branch", "-D", "--", request.branch], [], WORKTREE_ADD_MAX_BYTES, {
        timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS,
      });
      if (dropped.code === 0 && !dropped.timedOut) {
        return refused(`git worktree add took longer than ${seconds} s; the half-made checkout and its branch were removed`);
      }
      return refused(
        `git worktree add took longer than ${seconds} s; the half-made checkout was removed; branch ${request.branch} stayed behind`,
      );
    }
    return refused(`git worktree add took longer than ${seconds} s; the half-made checkout at ${path} could not be removed`);
  }
  if (run.code !== 0) return refused(firstSentence(run.stderr ?? "") ?? `git worktree add exited with ${String(run.code)}`);
  return { ok: true, path, existed: false };
}

/**
 * What git lists at `path` for the repo whose main checkout is `repoRoot`, against the branch a create
 * asks for. `null` when git is missing or could not answer. The folder rule asks it before it refuses
 * a target that exists, so a chosen folder gets the same answer as Herdr's default one.
 */
export async function worktreeMatchOf(
  repoRoot: string,
  path: string,
  branch: string,
  git?: string | null,
): Promise<WorktreeMatch | null> {
  const binary = git === undefined ? await gitBinary() : git;
  if (binary === null) return null;
  return worktreeMatch(binary, { workTree: repoRoot, gitDir: join(repoRoot, ".git") }, path, branch);
}

/** The one sentence a `worktree.target_exists` refusal carries for a folder git lists, by its state. */
export function targetExistsDetail(match: Exclude<WorktreeMatch, { kind: "absent" } | { kind: "same" }>): string {
  switch (match.kind) {
    case "other-branch":
      return match.branch === null ? "that folder holds a detached checkout" : `that folder holds branch ${match.branch}`;
    case "locked":
      return "a create is still running in that folder";
    case "prunable":
      return "git lists that folder as prunable";
    case "bare":
      return "git lists that folder as a bare repository";
    case "main":
      return "that folder is the repository's own checkout";
  }
}

function refused(detail: string): WorktreeAddOutcome {
  return { ok: false, code: "worktree.create_failed", detail };
}

function targetExists(path: string, match: Exclude<WorktreeMatch, { kind: "absent" } | { kind: "same" }>): WorktreeAddOutcome {
  return { ok: false, code: "worktree.target_exists", detail: targetExistsDetail(match), path };
}

/** What git lists at `path` for `repo` today. `null` when git could not answer. */
async function worktreeMatch(git: string, repo: RepoDirs, path: string, branch: string): Promise<WorktreeMatch | null> {
  const run = await runGit(git, repo, ["worktree", "list", "--porcelain"], [], WORKTREE_ADD_MAX_BYTES, {
    timeoutMs: WORKTREE_LIST_TIMEOUT_MS,
  });
  if (run.code !== 0 || run.timedOut || run.capped) return null;
  const blocks = parseWorktreeList(run.stdout.toString("utf8"));
  return matchWorktree(blocks, { path, branch, main: repo.workTree, realpath: realOrNull });
}

/**
 * One entry of `git worktree list --porcelain`. `branch` is the full ref (`refs/heads/x`), `null` for
 * a detached HEAD or a bare entry.
 */
export interface WorktreeBlock {
  path: string;
  branch: string | null;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

/**
 * What git lists at a folder, against the branch a create asks for:
 *
 * - `absent`: no entry for the folder, or the folder is not on disk;
 * - `same`: a linked worktree on that branch, finished (not locked, not prunable, not bare);
 * - `other-branch`: a linked worktree on another branch, `null` for a detached HEAD;
 * - `locked`, `prunable`, `bare`: an entry in that state, whatever its branch;
 * - `main`: the repo's own main checkout.
 */
export type WorktreeMatch =
  | { kind: "absent" }
  | { kind: "same" }
  | { kind: "other-branch"; branch: string | null }
  | { kind: "locked" }
  | { kind: "prunable" }
  | { kind: "bare" }
  | { kind: "main" };

/**
 * Every entry of `git worktree list --porcelain`, in order. The newline form, not `-z` (git 2.36):
 * a line that starts no known field is the tail of a path that held a newline, so its entry is
 * dropped, and a chunk after a blank line that does not start `worktree ` drops the entry before it.
 * A folder with a newline in its name therefore never matches.
 */
export function parseWorktreeList(porcelain: string): WorktreeBlock[] {
  const blocks: WorktreeBlock[] = [];
  for (const chunk of porcelain.split("\n\n")) {
    const lines = chunk.split("\n").filter((line) => line !== "");
    if (lines.length === 0) continue;
    if (!(lines[0] ?? "").startsWith("worktree ")) {
      blocks.pop();
      continue;
    }
    const block = parseBlock(lines);
    if (block !== null) blocks.push(block);
  }
  return blocks;
}

/** One entry's lines, its `worktree ` line first, or `null` when a line is no field git prints. */
function parseBlock(lines: readonly string[]): WorktreeBlock | null {
  const [first = "", ...rest] = lines;
  const block: WorktreeBlock = { path: first.slice("worktree ".length), branch: null, bare: false, locked: false, prunable: false };
  for (const line of rest) {
    if (line.startsWith("HEAD ") || line === "detached") continue;
    if (line.startsWith("branch ")) {
      block.branch = line.slice("branch ".length);
      continue;
    }
    if (line === "bare") {
      block.bare = true;
      continue;
    }
    if (line === "locked" || line.startsWith("locked ")) {
      block.locked = true;
      continue;
    }
    if (line === "prunable" || line.startsWith("prunable ")) {
      block.prunable = true;
      continue;
    }
    return null;
  }
  return block;
}

/** What {@link matchWorktree} compares against: the folder, the branch asked for, the main checkout. */
export interface MatchQuery {
  path: string;
  branch: string;
  main: string;
  /** The real path of a folder, or `null` when it is not on disk. */
  realpath(path: string): Promise<string | null>;
}

/** The entry of `blocks` at `query.path`, compared by real path, read as a {@link WorktreeMatch}. */
export async function matchWorktree(blocks: readonly WorktreeBlock[], query: MatchQuery): Promise<WorktreeMatch> {
  const target = await query.realpath(query.path);
  // A folder that is not on disk is not one, whatever git still has registered for it.
  if (target === null) return { kind: "absent" };
  const main = await query.realpath(query.main);
  for (const block of blocks) {
    if ((await query.realpath(block.path)) !== target) continue;
    if (target === main) return { kind: "main" };
    if (block.bare) return { kind: "bare" };
    if (block.prunable) return { kind: "prunable" };
    if (block.locked) return { kind: "locked" };
    if (block.branch === `refs/heads/${query.branch}`) return { kind: "same" };
    return { kind: "other-branch", branch: branchName(block.branch) };
  }
  return { kind: "absent" };
}

/** A full ref as a branch name: `refs/heads/x` is `x`; any other ref as it is; `null` stays `null`. */
function branchName(ref: string | null): string | null {
  const prefix = "refs/heads/";
  if (ref === null || !ref.startsWith(prefix)) return ref;
  return ref.slice(prefix.length);
}

/** Every `worktree <path>` line of `git worktree list --porcelain`, in order. */
export function worktreePaths(porcelain: string): string[] {
  return parseWorktreeList(porcelain).map((block) => block.path);
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

/** Whether anything, a dangling link included, sits at `path`. */
async function isOnDisk(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function realOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

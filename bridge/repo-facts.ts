// WHICH REPO A FOLDER BELONGS TO, AND WHETHER IT IS A LINKED WORKTREE, read off disk.
//
// The web nests a worktree's space under its repo's space from two facts on `MuxSpace`: `repoRoot`
// and `isWorktree`. Herdr used to be the only multiplexer to supply them, from its daemon's worktree
// records. This module answers for ANY folder, so every multiplexer nests alike, and it does so the
// way `git-head.ts` reads a branch: with a few `stat` and `readFile` calls and never a git process.
// A process per space per poll would cost a fork on every phone poll, and git commands may take
// `index.lock` against an agent that is committing in the same checkout.
//
// ── THE THREE SHAPES OF `.git` ───────────────────────────────────────────────────────────────────
// Walk up from the folder to the nearest `.git`:
//   • a DIRECTORY: the folder holding it is a main checkout. `{ repoRoot: that folder, isWorktree: false }`.
//   • a FILE `gitdir: <main>/.git/worktrees/<name>`: a linked worktree. `repoRoot` is the folder that
//     holds `<main>/.git`, `isWorktree` is true.
//   • a FILE of any other shape (a submodule's `gitdir: ../.git/modules/x`, a path that does not
//     resolve): `null`. A submodule is its own repo but not a worktree of anything, and guessing a
//     root for it would nest it under the wrong row.
// No `.git` at all, or a folder that does not exist: `null`.

import { basename, dirname, isAbsolute, join } from "node:path";

import { nodeGitHeadDisk, parseGitFile, type GitHeadDisk } from "./git-head.ts";

/** What a folder's checkout is: the repo it belongs to, and whether it is a linked worktree of it. */
export interface RepoFacts {
  readonly repoRoot: string;
  readonly isWorktree: boolean;
}

/** A `.git` FILE is one `gitdir:` line holding a path. */
const GIT_FILE_MAX_BYTES = 4096;
/** The walk up from a folder stops here even if the root is further, so a loop cannot run away. */
const MAX_DEPTH = 64;

/**
 * The repo facts of `folder`, or `null` when it has none this module can state.
 *
 * Disk reads only, through the same narrow disk `git-head.ts` uses. Never throws: the disk answers
 * `null` for anything that is not a plain answer.
 */
export async function repoFactsOf(folder: string, disk: GitHeadDisk = nodeGitHeadDisk): Promise<RepoFacts | null> {
  if (!isAbsolute(folder) || (await disk.kind(folder)) !== "dir") return null;
  let dir = folder;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const dotGit = join(dir, ".git");
    const kind = await disk.kind(dotGit);
    if (kind === "dir") return { repoRoot: dir, isWorktree: false };
    if (kind === "file") return linkedWorktreeFacts(await disk.readHead(dotGit, GIT_FILE_MAX_BYTES), dir);
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** The facts for a `.git` FILE's text found in `holder`, or `null` unless it names a linked worktree. */
function linkedWorktreeFacts(text: string | null, holder: string): RepoFacts | null {
  if (text === null) return null;
  const gitDir = parseGitFile(text, holder);
  if (gitDir === null) return null;
  // `<main>/.git/worktrees/<name>`: the entry's parent is `worktrees`, and that one's parent is `.git`.
  const worktrees = dirname(gitDir);
  if (basename(worktrees) !== "worktrees") return null;
  const mainGit = dirname(worktrees);
  if (basename(mainGit) !== ".git") return null;
  return { repoRoot: dirname(mainGit), isWorktree: true };
}

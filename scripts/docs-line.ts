#!/usr/bin/env bun
// THE DOCS LINE. A branch `docs/<newest release tag>` on origin that carries docs-only commits, so
// colliepwa.dev can publish a docs fix before the next release.
//
//   bun scripts/docs-line.ts <commit>... [--dry-run] [--allow-unmerged]
//
// Why it exists. The website quotes `docs/*.md` at the newest published release tag. A docs fix on
// `main` therefore sat unpublished until the next release, and a docs-only release makes every
// self-updating lane update for nothing (CLAUDE.md → Versioning). The website's daily sync now looks
// for a branch `docs/T` (T is the newest release tag) and quotes that branch instead of the tag. It
// refuses the branch unless T is an ancestor of its head and `git diff --name-only T HEAD` lists
// only paths under `docs/` or `README.md`. This script applies the same two guards BEFORE it pushes,
// so a bad commit fails on the maintainer's machine and not on the site. When the next release is
// tagged, the site follows the new tag and ignores the old branch.
//
// What it does, in order:
//   1. Finds the newest `vX.Y.Z` tag on origin (`git ls-remote`, no suffixed tags). That is T.
//   2. Refuses any given commit that is not on `origin/main`, that touches a path outside `docs/`
//      and `README.md`, or that deletes or renames a `docs/*.md` page. Nothing has been touched yet
//      when it does.
//   3. Fetches T and `docs/T` (when origin has it), and makes a temporary detached worktree at
//      `origin/docs/T`, else at T. Your checkout, index and branch are never touched.
//   4. Cherry-picks each commit with `-x`. A commit already on the line (its `-x` trailer is in
//      `T..HEAD`) is skipped. A conflict aborts the pick, removes the worktree, exits 1.
//   5. Re-checks the guards on the result, prints the tag, the commits and `git diff --stat T HEAD`
//      so the operator sees what goes public, then pushes `HEAD:refs/heads/docs/T` (no force).
//   6. Lists older `docs/v*` branches with the exact delete command. It never deletes one.
//
// `--dry-run` does everything except the push and prints `git log --oneline T..HEAD`.
//
// `--allow-unmerged` lifts the `origin/main` requirement. The line is a mirror of main's docs: a fix
// that lives only on the line vanishes at the next tag, and its `-x` trailer would name a sha that
// is rebased away.
//
// Only a docs commit that describes the RELEASED version belongs on the line. Docs for a feature
// that has not shipped stay on main until its release (CLAUDE.md → Versioning).
//
// Every git call is an argv array through `execFileSync`: no shell, so it runs the same on Windows.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REMOTE = "origin";
const DISPATCH_WORKFLOW = ".github/workflows/docs-line.yml";
const SYNC_COMMAND = "gh workflow run sync-docs.yml -R AltanS/collie-website";

/** `[major, minor, patch]` of a plain `vX.Y.Z` tag, or null for anything else (a suffix, a typo). */
export function parseReleaseTag(tag: string): [number, number, number] | null {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Negative when `a` is the lower version, positive when higher, 0 when equal. Plain tags only. */
export function compareReleaseTags(a: string, b: string): number {
  const pa = parseReleaseTag(a);
  const pb = parseReleaseTag(b);
  if (!pa || !pb) throw new Error(`not a release tag: ${pa ? b : a}`);
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
}

/**
 * The highest `vX.Y.Z` tag in a `git ls-remote --tags` listing, or null when there is none. Only
 * `refs/tags/vX.Y.Z` counts: a suffixed tag (`v1.2.3-edge.1`) is a prerelease and the site never
 * quotes it, and the peeled `^{}` lines of annotated tags repeat a tag already seen.
 */
export function newestReleaseTag(lsRemote: string): string | null {
  let best: string | null = null;
  for (const line of lsRemote.split(/\r?\n/)) {
    const m = /^[0-9a-f]+\s+refs\/tags\/(v\d+\.\d+\.\d+)$/.exec(line.trim());
    if (!m?.[1]) continue;
    if (best === null || compareReleaseTags(m[1], best) > 0) best = m[1];
  }
  return best;
}

/** The names of the `docs/vX.Y.Z` branches in a `git ls-remote --heads` listing, without `docs/`. */
export function docsBranchTags(lsRemoteHeads: string): string[] {
  const tags: string[] = [];
  for (const line of lsRemoteHeads.split(/\r?\n/)) {
    const m = /^[0-9a-f]+\s+refs\/heads\/docs\/(v\d+\.\d+\.\d+)$/.exec(line.trim());
    if (m?.[1]) tags.push(m[1]);
  }
  return tags;
}

/** True for a path the docs line may carry: anything under `docs/`, and the root `README.md`. */
export function isDocsPath(path: string): boolean {
  return path === "README.md" || path.startsWith("docs/");
}

/** The paths of a name list that the docs line may not carry. Empty means the list is docs-only. */
export function pathsOutsideDocs(paths: readonly string[]): string[] {
  return paths.filter((p) => p !== "" && !isDocsPath(p));
}

/** One line of `git ... --name-status --no-renames` output: a status letter and a path. */
export interface PathStatus {
  status: string;
  path: string;
}

/** Splits `git ... --name-status --no-renames` output into entries. */
export function splitNameStatus(output: string): PathStatus[] {
  const entries: PathStatus[] = [];
  for (const line of output.split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    entries.push({ status: line.slice(0, tab), path: line.slice(tab + 1) });
  }
  return entries;
}

/**
 * The `docs/*.md` pages an entry list deletes. With `--no-renames` a rename shows as a delete plus an
 * add, so a renamed page is caught too. `release.yml` prints one embedded page by name and the
 * website keeps a generated copy per page, so a renamed or deleted page breaks the next release run
 * (CLAUDE.md, "Traps").
 */
export function deletedDocsPages(entries: readonly PathStatus[]): string[] {
  return entries.filter((e) => e.status === "D" && /^docs\/[^/]+\.md$/.test(e.path)).map((e) => e.path);
}

/** True when `body` (`git log --format=%b` output) holds the `cherry-pick -x` trailer for `sha`. */
export function hasPickTrailer(body: string, sha: string): boolean {
  return body.includes(`(cherry picked from commit ${sha})`);
}

/** Splits `git ... --name-only` output into paths. */
export function splitPaths(output: string): string[] {
  return output.split(/\r?\n/).filter((l) => l !== "");
}

/** A failure the maintainer can act on. `main` prints the message and exits 1. */
export class DocsLineError extends Error {}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitOk(args: string[], cwd: string): boolean {
  try {
    git(args, cwd);
    return true;
  } catch {
    return false;
  }
}

/** An error from `execFileSync`: with `encoding: "utf8"` it carries the child's output as text. */
interface ChildError extends Error {
  stdout?: string;
  stderr?: string;
}

function errorText(error: ChildError): string {
  const text = [error.stdout, error.stderr]
    .map((part) => (part ?? "").trim())
    .filter((part) => part !== "")
    .join("\n");
  return text === "" ? error.message : text;
}

function say(line: string): void {
  console.log(`docs-line: ${line}`);
}

export interface Options {
  commits: string[];
  dryRun: boolean;
  allowUnmerged: boolean;
}

/** Parses argv (without the runtime and script). Throws a {@link DocsLineError} on bad usage. */
export function parseArgs(argv: readonly string[]): Options {
  const commits: string[] = [];
  let dryRun = false;
  let allowUnmerged = false;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--allow-unmerged") allowUnmerged = true;
    else if (arg.startsWith("-")) throw new DocsLineError(`unknown option ${arg}`);
    else commits.push(arg);
  }
  if (commits.length === 0) {
    throw new DocsLineError("usage: bun scripts/docs-line.ts [--dry-run] [--allow-unmerged] <commit>...");
  }
  return { commits, dryRun, allowUnmerged };
}

/** Runs the docs line from `cwd`, a clone whose `origin` is the Collie repository. */
export function run(opts: Options, cwd: string): void {
  say(`reading tags on ${REMOTE}`);
  const tag = newestReleaseTag(git(["ls-remote", "--tags", REMOTE], cwd));
  if (tag === null) throw new DocsLineError(`no vX.Y.Z release tag on ${REMOTE}`);
  const branch = `docs/${tag}`;
  say(`newest release tag is ${tag}, so the line is ${branch}`);

  const mainRef = `refs/remotes/${REMOTE}/main`;
  if (!opts.allowUnmerged) git(["fetch", "--quiet", REMOTE, `+refs/heads/main:${mainRef}`], cwd);

  const shas: string[] = [];
  const refused: string[] = [];
  for (const commit of opts.commits) {
    let sha: string;
    try {
      sha = git(["rev-parse", "--verify", "--quiet", `${commit}^{commit}`], cwd).trim();
    } catch {
      throw new DocsLineError(`${commit} is not a commit in this clone`);
    }
    const parents = git(["rev-list", "--parents", "-n", "1", sha], cwd).trim().split(/\s+/);
    if (parents.length > 2) throw new DocsLineError(`${commit} is a merge commit; pick its parts`);
    if (!opts.allowUnmerged && !gitOk(["merge-base", "--is-ancestor", sha, mainRef], cwd)) {
      throw new DocsLineError(`${commit} is not on ${REMOTE}/main; land it there first, or pass --allow-unmerged`);
    }
    // --no-renames: a rename out of `cli/` into `docs/` lists both paths, and the old one is refused.
    const entries = splitNameStatus(
      git(["diff-tree", "--no-commit-id", "--no-renames", "--name-status", "-r", sha], cwd),
    );
    for (const p of pathsOutsideDocs(entries.map((e) => e.path))) refused.push(`  ${commit}: ${p}`);
    for (const p of deletedDocsPages(entries)) refused.push(`  ${commit}: deletes or renames the page ${p}`);
    shas.push(sha);
  }
  if (refused.length > 0) {
    throw new DocsLineError(
      `refused, these paths are outside docs/ and README.md, or delete or rename a docs page:\n${refused.join("\n")}\nnothing was changed`,
    );
  }
  say(`${shas.length} commit(s) touch only docs/ and README.md`);

  const heads = git(["ls-remote", "--heads", REMOTE, "refs/heads/docs/v*"], cwd);
  const onRemote = docsBranchTags(heads);
  const branchExists = onRemote.includes(tag);

  say(`fetching ${tag}${branchExists ? ` and ${branch}` : ""}`);
  git(["fetch", "--quiet", REMOTE, `refs/tags/${tag}:refs/tags/${tag}`], cwd);
  let start = `refs/tags/${tag}`;
  if (branchExists) {
    start = `refs/remotes/${REMOTE}/${branch}`;
    git(["fetch", "--quiet", REMOTE, `+refs/heads/${branch}:${start}`], cwd);
  }

  const scratch = mkdtempSync(join(tmpdir(), "docs-line-"));
  const tree = join(scratch, "tree");
  let added = false;
  const cleanup = (): void => {
    if (added) gitOk(["worktree", "remove", "--force", tree], cwd);
    rmSync(scratch, { recursive: true, force: true });
  };
  try {
    say(`worktree at ${branchExists ? `${REMOTE}/${branch}` : tag}`);
    git(["worktree", "add", "--quiet", "--detach", tree, start], cwd);
    added = true;
    const onLine = git(["log", "--format=%b", `refs/tags/${tag}..HEAD`], tree);
    for (const sha of shas) {
      if (hasPickTrailer(onLine, sha)) {
        say(`${sha.slice(0, 10)} is already on the line, skipped`);
        continue;
      }
      try {
        git(["cherry-pick", "-x", sha], tree);
      } catch (err) {
        const message = errorText(err instanceof Error ? err : new Error(String(err)));
        gitOk(["cherry-pick", "--abort"], tree);
        throw new DocsLineError(`cherry-pick of ${sha.slice(0, 10)} failed, nothing pushed:\n${message}`);
      }
      say(`picked ${sha.slice(0, 10)}`);
    }

    if (!gitOk(["merge-base", "--is-ancestor", `refs/tags/${tag}`, "HEAD"], tree)) {
      throw new DocsLineError(`${tag} is not an ancestor of the result, nothing pushed`);
    }
    const entries = splitNameStatus(git(["diff", "--no-renames", "--name-status", `refs/tags/${tag}`, "HEAD"], tree));
    const changed = entries.map((e) => e.path);
    const bad = pathsOutsideDocs(changed);
    if (bad.length > 0) {
      throw new DocsLineError(`the result differs from ${tag} outside docs/:\n  ${bad.join("\n  ")}`);
    }
    const gone = deletedDocsPages(entries);
    if (gone.length > 0) {
      throw new DocsLineError(`the result deletes or renames a docs page, nothing pushed:\n  ${gone.join("\n  ")}`);
    }
    say(`checked: ${tag} is an ancestor, ${changed.length} changed path(s), all docs-only`);

    // What goes public, shown before the push (and in a dry run).
    say(`tag ${tag}, branch ${branch}, commits on the line:`);
    console.log(git(["log", "--format=%h %s", `refs/tags/${tag}..HEAD`], tree).trimEnd());
    console.log(git(["diff", "--stat", `refs/tags/${tag}`, "HEAD"], tree).trimEnd());

    // The dispatch workflow fires only when the pushed branch itself holds the file, and a branch
    // based on an old tag may predate it.
    const toldSite = gitOk(["cat-file", "-e", `HEAD:${DISPATCH_WORKFLOW}`], tree);
    if (opts.dryRun) {
      say("dry run, nothing pushed");
      if (!toldSite) say(`dry run: ${branch} has no docs-line.yml, so the site would not be told`);
    } else {
      // --no-verify: the branch is docs-only by construction and both guards just ran. The pre-push
      // hook's test suites and typecheck are about code and need an installed worktree, which this
      // temporary one is not.
      git(["push", "--no-verify", REMOTE, `HEAD:refs/heads/${branch}`], tree);
      say(`pushed ${branch} to ${REMOTE}`);
      if (!toldSite) say(`the branch has no docs-line.yml, so the site is not told; run: ${SYNC_COMMAND}; the daily sync picks the branch up within a day in any case`);
    }
    say(`git log --oneline ${tag}..HEAD`);
    console.log(git(["log", "--oneline", `refs/tags/${tag}..HEAD`], tree).trimEnd());
  } finally {
    cleanup();
  }
  say("worktree removed");

  for (const old of onRemote) {
    if (compareReleaseTags(old, tag) >= 0) continue;
    say(`old branch docs/${old}, delete with: git push ${REMOTE} --delete docs/${old}`);
  }
}

/** Entry point. Returns the exit code. */
export function main(argv: readonly string[], cwd: string): number {
  try {
    run(parseArgs(argv), cwd);
    return 0;
  } catch (err) {
    const text = err instanceof DocsLineError ? err.message : errorText(err instanceof Error ? err : new Error(String(err)));
    console.error(`docs-line: ${text}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2), process.cwd()));
}

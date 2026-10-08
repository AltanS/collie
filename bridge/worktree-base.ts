// ── Where a new worktree starts from (ADR 0089, amended) ──────────────────────────────────────────
//
// Herdr's `worktree.create` cuts the new branch from `base`, or from the HEAD of the folder it was
// asked from when there is none (`herdr api schema --json`, 0.9.3: `WorktreeCreateParams.base`).
// That HEAD is whatever the repo's own checkout happens to be on, which is rarely what an operator
// who taps "New agent on a branch" means. The phone now says which of two starting points it wants:
//
//   { kind: "default" }          the repo's default branch, resolved HERE, on the bridge
//   { kind: "ref", ref: "x" }    the named ref (the sheet sends the pane's own branch)
//
// and a body with no `base` at all keeps today's behaviour to the byte: no `base` reaches Herdr and
// no git process runs.
//
// ── THE REF IS A NAME, NEVER A FLAG ──────────────────────────────────────────────────────────────
// A ref comes off the wire and ends up in a git command line, so it is checked twice: by
// {@link isValidBaseRef} (a strict subset of `git check-ref-format`, run before anything is spawned)
// and then by git itself (`check-ref-format`, then `rev-parse --verify` that it names a commit). Git
// is only ever started with an argv array, through `runGit` (bridge/changes.ts), which also strips
// `GIT_*` from the environment and refuses every transport: NOTHING HERE FETCHES, so a default that
// the remote moved since the last fetch is still the default the operator last saw.
//
// ── DEFAULT RESOLUTION ORDER ─────────────────────────────────────────────────────────────────────
//   1. `refs/remotes/origin/HEAD`, with `origin/` stripped, when that LOCAL branch exists;
//   2. a local `main`;
//   3. a local `master`;
//   4. nothing: no `base` is sent and Herdr starts from the HEAD it always did.

import { join } from "node:path";

import { gitBinary, runGit, type RepoDirs } from "./changes.ts";
import type { JsonValue } from "./json.ts";
import { isValidWorktreeBranch } from "./worktree-branch.ts";

/** A ref name past this is not one worth sending, and not one git would make by hand. */
export const MAX_BASE_REF_LENGTH = 200;

/** Each git run here is killed after this long. A ref lookup reads a file or two. */
const BASE_GIT_TIMEOUT_MS = 3_000;
/** The most stdout read from one run: a ref name, or nothing. */
const BASE_GIT_MAX_BYTES = 1024;

/** What the phone may ask a worktree to start from. */
export type WorktreeBaseRequest = { kind: "default" } | { kind: "ref"; ref: string };

/**
 * Whether `ref` may be handed to git as a starting point.
 *
 * Refuses: empty, past {@link MAX_BASE_REF_LENGTH}, a leading `-` (it would read as an option) or
 * `/`, whitespace and control characters, `..`, `@{`, `\`, `~`, `^`, `:`, `?`, `*`, `[`, `//`, a
 * trailing `/`, `.` or `.lock`, a path component starting with `.` or ending in `.lock`, and the
 * lone `@`. The surrounding text is NOT trimmed: a ref with a space in it is refused, not repaired.
 */
export function isValidBaseRef(ref: string): boolean {
  if (ref.length === 0 || ref.length > MAX_BASE_REF_LENGTH) return false;
  if (ref.startsWith("/") || ref.endsWith(".") || ref === "@") return false;
  if (!isValidWorktreeBranch(ref)) return false;
  return ref.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

/** A request body's `base` field, read strictly. `base` is absent (undefined) when the phone sent none. */
export type ParsedBase = { ok: true; base: WorktreeBaseRequest | undefined } | { ok: false };

/**
 * `fields.base` of a create request as a {@link WorktreeBaseRequest}.
 *
 * Absent, or `null`, is "no preference" and keeps today's behaviour. Anything else must be exactly
 * `{ kind: "default" }` or `{ kind: "ref", ref }` with a ref that passes {@link isValidBaseRef};
 * every other shape is a refusal, never a guess.
 */
export function parseBase(raw: JsonValue | undefined): ParsedBase {
  if (raw === undefined || raw === null) return { ok: true, base: undefined };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
  if (raw.kind === "default") return { ok: true, base: { kind: "default" } };
  if (raw.kind !== "ref" || typeof raw.ref !== "string") return { ok: false };
  return isValidBaseRef(raw.ref) ? { ok: true, base: { kind: "ref", ref: raw.ref } } : { ok: false };
}

// ── Git, narrowed to what this module asks ───────────────────────────────────────────────────────

/**
 * One read-only git question about a repo: the trimmed stdout of a run that exited 0, or `null` for
 * anything else (a non-zero exit, a timeout, git not installed, a repo git refuses to read).
 */
export type GitAsk = (repoRoot: string, args: readonly string[]) => Promise<string | null>;

/** The real thing: a hardened `git` against the repo's own `.git`, argv only, never a shell. */
export const askGit: GitAsk = async (repoRoot, args) => {
  const git = await gitBinary();
  if (git === null) return null;
  const repo: RepoDirs = { workTree: repoRoot, gitDir: join(repoRoot, ".git") };
  try {
    const run = await runGit(git, repo, args, [], BASE_GIT_MAX_BYTES, { timeoutMs: BASE_GIT_TIMEOUT_MS });
    if (run.code !== 0 || run.timedOut || run.capped) return null;
    return run.stdout.toString("utf8").trim();
  } catch {
    return null;
  }
};

/** Whether `refs/heads/<name>` is a local branch pointing at a commit. */
async function localBranchExists(ask: GitAsk, repoRoot: string, name: string): Promise<boolean> {
  if (!isValidBaseRef(name)) return false;
  return (await ask(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}^{commit}`])) !== null;
}

/**
 * The repo's default branch as a LOCAL branch name, or `null` when none can be named.
 *
 * `origin/HEAD` first, because it is what the remote called its default when the repo was cloned;
 * then `main`, then `master`. Only a branch that exists locally counts: the new worktree is cut
 * from it without any fetch, so a name with no local branch behind it would be a base that fails.
 */
export async function resolveDefaultBranch(repoRoot: string, ask: GitAsk = askGit): Promise<string | null> {
  const origin = await ask(repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (origin !== null && origin.startsWith("origin/")) {
    const name = origin.slice("origin/".length);
    if (await localBranchExists(ask, repoRoot, name)) return name;
  }
  for (const name of ["main", "master"]) {
    if (await localBranchExists(ask, repoRoot, name)) return name;
  }
  return null;
}

/**
 * Whether `ref` is a ref git accepts that names a commit in this repo. A local branch of that name
 * wins over a tag or a remote ref; either one passes.
 */
export async function refNamesCommit(repoRoot: string, ref: string, ask: GitAsk = askGit): Promise<boolean> {
  if (!isValidBaseRef(ref)) return false;
  if ((await ask(repoRoot, ["check-ref-format", "--allow-onelevel", ref])) === null) return false;
  if (await localBranchExists(ask, repoRoot, ref)) return true;
  return (await ask(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) !== null;
}

/** What a create does about its base: send `ref` to the multiplexer, or send none, or refuse. */
export type ResolvedBase = { ok: true; ref: string | undefined } | { ok: false };

/**
 * The ref a create hands to the multiplexer.
 *
 * `undefined` request: no ref, and no git process. `default`: {@link resolveDefaultBranch}, which may
 * itself come up empty (the multiplexer then starts from its own HEAD). `ref`: refused when it does
 * not name a commit here, so a wrong tap is a plain 400 and never a minute-long Herdr failure.
 */
export async function resolveBase(
  request: WorktreeBaseRequest | undefined,
  repoRoot: string,
  ask: GitAsk = askGit,
): Promise<ResolvedBase> {
  if (request === undefined) return { ok: true, ref: undefined };
  if (request.kind === "default") return { ok: true, ref: (await resolveDefaultBranch(repoRoot, ask)) ?? undefined };
  return (await refNamesCommit(repoRoot, request.ref, ask)) ? { ok: true, ref: request.ref } : { ok: false };
}

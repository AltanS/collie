// The pure half of the Changes screen's reads: what each read holds, and how an answer folds into
// what is already on screen. Moved out of the component so `state.test.ts` pins the rules without a
// DOM (web/src/routes/changes.tsx `nextFile` and `nextCommit` are the originals).
//
// THE RULE for all three: an answer equal to what is on screen keeps the SAME object, so a caller
// compares one reference and skips the render; nothing the reader looks at is replaced under them.
import { shareEqual } from "@web/lib/share-equal";
import type { ChangeCommitDiffResponse, ChangeCommitResponse, ChangeDiffResponse, ChangesResponse } from "@web/lib/types";

/** Consecutive failed re-reads before the header says the screen has stopped updating. */
export const STALE_AFTER_FAILURES = 2;

/** Why a read runs: the screen opened, the operator tapped refresh, or the timer fired. */
export type ReadMode = "open" | "manual" | "poll";

export type ListState =
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "ready"; data: ChangesResponse };

/** A diff either screen reads: an uncommitted file's, or one file of the last commit. */
export type AnyDiff = ChangeDiffResponse | ChangeCommitDiffResponse;

export type FileState =
  | { phase: "loading"; key: string }
  | { phase: "error"; key: string }
  // `gone`: a re-read found the file no longer changed. `data` stays the last diff that was.
  // `moved`: a commit file's first read came from a newer commit than the one on screen.
  | { phase: "ready"; key: string; data: AnyDiff; gone?: true; moved?: true };

/**
 * The file state after a read of `key` answered `data`. The same answer keeps the old state object.
 * A file that has left the list keeps its last diff and is marked gone, rather than turning into an
 * error screen under the operator's eyes. A commit file answered from a commit other than
 * `shownHash` (HEAD moved) keeps the diff on screen, or, on a first read, says so.
 */
export function nextFile(prev: FileState | null, key: string, data: AnyDiff, shownHash?: string): FileState {
  const same = prev?.key === key && prev.phase === "ready" ? prev : null;
  if (shownHash !== undefined && data.available && "hash" in data && data.hash !== shownHash) {
    return same ?? { phase: "ready", key, data, moved: true };
  }
  if (same === null) return { phase: "ready", key, data };
  const left = !data.available && (data.reason === "unknown-path" || data.reason === "unknown-repo");
  if (left && same.data.available) return same.gone ? same : { ...same, gone: true };
  const shared = shareEqual(same.data, data);
  if (shared === same.data && !same.gone && !same.moved) return same;
  return { phase: "ready", key, data: shared };
}

export type CommitState =
  | { phase: "loading"; repo: string }
  | { phase: "error"; repo: string }
  // `newer`: a re-read found a newer HEAD. It waits for a tap; `data` stays on screen.
  | { phase: "ready"; repo: string; data: ChangeCommitResponse; newer?: ChangeCommitResponse };

/** The commit state after a re-read of `repo` answered `data`. Never swaps the commit on screen. */
export function nextCommit(prev: CommitState | null, repo: string, data: ChangeCommitResponse): CommitState {
  if (prev?.repo !== repo || prev.phase !== "ready") return { phase: "ready", repo, data };
  const shown = prev.data;
  if (shown.available && data.available && data.commit.hash !== shown.commit.hash) {
    const newer = prev.newer === undefined ? data : shareEqual(prev.newer, data);
    return newer === prev.newer ? prev : { ...prev, newer };
  }
  // A re-read that cannot see the repo any more keeps the commit on screen.
  if (shown.available && !data.available) return prev;
  const shared = shareEqual(shown, data);
  if (shared === shown && prev.newer === undefined) return prev;
  return { phase: "ready", repo, data: shared };
}

/** The list state after a read answered `data`: the same object when nothing changed. */
export function nextList(prev: ListState, data: ChangesResponse): ListState {
  if (prev.phase !== "ready") return { phase: "ready", data };
  const shared = shareEqual(prev.data, data);
  return shared === prev.data ? prev : { phase: "ready", data: shared };
}

/** The one-call memo the route derives its lists with: recompute only when an input changed. */
export function memoOf<A extends readonly unknown[], R>(compute: (...args: A) => R): (...args: A) => R {
  let last: { args: A; value: R } | null = null;
  return (...args) => {
    if (last !== null && last.args.length === args.length && last.args.every((a, i) => Object.is(a, args[i]))) return last.value;
    const value = compute(...args);
    last = { args, value };
    return value;
  };
}

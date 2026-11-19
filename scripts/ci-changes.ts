// The `changes` job of `ci.yml`: which heavy jobs does this run need? It prints one line per job,
// `frozen=true`, `bun_floor=false` and so on, and appends them to $GITHUB_OUTPUT when that is set.
// The path lists are in `scripts/test-sets.ts` (`CI_JOB_PATHS`).
//
// A job is skipped, not removed: a skipped job reports as passed, so a check that branch protection
// names never hangs. Every job runs, whatever the paths, on a nightly run, on a manual dispatch, and
// whenever the changed files cannot be worked out (a new branch, a force push, a shallow clone).
//
// Environment (set by `ci.yml`):
//   GITHUB_EVENT_NAME   `pull_request`, `push`, `schedule` or `workflow_dispatch`
//   CI_BASE, CI_HEAD    the two commits to compare: the PR's base and head, or a push's before and after

import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { type CiJob, wakes } from "./test-sets.ts";

const ROOT = join(import.meta.dir, "..");

/** Each job and the name of its output, in the order they are printed. */
const OUTPUTS: readonly (readonly [CiJob, string])[] = [
  ["frozen", "frozen"],
  ["bunFloor", "bun_floor"],
  ["durable", "durable"],
  ["swap", "swap"],
];

/** The changed paths, or null when they cannot be worked out. */
export function changedPaths(base: string, head: string, cwd: string = ROOT): string[] | null {
  if (base === "" || head === "" || /^0+$/.test(base)) return null;
  // Three dots: what the head holds that the merge base does not, which is what a PR adds.
  const diff = Bun.spawnSync(["git", "diff", "--name-only", `${base}...${head}`], { cwd });
  if (diff.exitCode !== 0) return null;
  return diff.stdout.toString().split("\n").filter((line) => line !== "");
}

/** One `name=true|false` line per job. */
export function decide(event: string, changed: readonly string[] | null): string[] {
  const everything = event === "schedule" || event === "workflow_dispatch" || changed === null;
  return OUTPUTS.map(([job, name]) => `${name}=${everything || wakes(job, changed ?? [])}`);
}

if (import.meta.main) {
  const event = process.env.GITHUB_EVENT_NAME ?? "";
  const changed = changedPaths(process.env.CI_BASE ?? "", process.env.CI_HEAD ?? "");
  const lines = decide(event, changed);
  console.log(`event ${event === "" ? "(none)" : event}, ${changed === null ? "changed files unknown, so every job runs" : `${changed.length} changed files`}`);
  for (const line of lines) console.log(line);
  const out = process.env.GITHUB_OUTPUT;
  if (out !== undefined && out !== "") appendFileSync(out, `${lines.join("\n")}\n`);
}

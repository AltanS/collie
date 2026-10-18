// What a finished lab run leaves behind (M56 spec 10).
//
// PASS: one commit on a branch `harness-lab/<harness>-<version>` in a scratch worktree the script
// makes under `<lab root>/worktrees/`, from the repo path it is given. The commit touches two files and
// no other: `web/src/lib/harness/verified-versions.json` (the harness's row) and the harness's profile
// (the verified range, `verifiedThrough` and `verifiedOn`). When the profile's range already reaches the
// version, because a person moved it by hand before the lab ran, the commit moves the row alone.
// The commit body is the run log. THE SCRIPT
// NEVER PUSHES. A person reads the branch and merges it.
//
// FAIL: an issue written as files (a JSON file with the title, the label and the body, and the same
// body as Markdown) under `<lab root>/issues/`. The body holds the redacted screens, the Surface
// verdicts and the counters. `gh issue create` runs only when the caller passes `openIssue`, which the
// ritual never does: a public issue is posted by a person, after Altan has seen the draft.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asJsonObject, asJsonString, parseJson } from "../../../web/src/lib/json";
import { withRecord } from "../ledger";
import { redact, redactRows, type RedactContext } from "./redact";
import { phoneLines } from "./phone-verdict";
import { isDialogScreen, type LabFacts, type ScreenFact, type Verdict } from "./verdict";

export const LEDGER_REL = "web/src/lib/harness/verified-versions.json";
export const profileRel = (harness: string): string => `web/src/lib/surface/profiles/${harness}.json`;
export const ISSUE_LABEL = "harness-drift";

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs git in a directory. A test gives it a fake. */
export type Git = (cwd: string, args: readonly string[], env?: Readonly<Record<string, string>>) => GitResult;

export const realGit: Git = (cwd, args, env) => {
  const run = Bun.spawnSync(["git", "-C", cwd, ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
};

function must(result: GitResult, what: string): string {
  if (result.code !== 0) throw new Error(`git ${what} failed (${String(result.code)}): ${result.stderr.trim()}`);
  return result.stdout.trim();
}

// ── The profile edit ─────────────────────────────────────────────────────────────────────────────

function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

function once(text: string, from: string, to: string, what: string): string {
  const first = text.indexOf(from);
  if (first < 0 || text.indexOf(from, first + 1) >= 0) throw new Error(`profile: ${what} must appear exactly once to be moved`);
  return text.replace(from, to);
}

/**
 * The profile text with its one verified range moved to `version` on `date`: the upper end of the
 * range (unless it is `*`), `verifiedThrough` and `verifiedOn`. Only those three strings change; the
 * layout of the file is kept. A version the range already reaches (equal to `verifiedThrough`) leaves
 * the text as it is: a person verified it by hand, and moving `verifiedOn` would rewrite their date.
 * Throws when the profile has no single verified range or the version is older than the one it holds.
 */
export function moveProfile(text: string, version: string, date: string): string {
  const root = asJsonObject(parseJson(text));
  const ranges = Array.isArray(root?.versions) ? root.versions : [];
  const verified = ranges.map((range) => asJsonObject(range)).filter((range) => range?.status === "verified");
  if (verified.length !== 1 || verified[0] === undefined) throw new Error("profile: expected exactly one verified range");
  const range = asJsonString(verified[0].range);
  const through = asJsonString(verified[0].verifiedThrough);
  const on = asJsonString(verified[0].verifiedOn);
  if (range === undefined || through === undefined || on === undefined) throw new Error("profile: the verified range is missing a field");
  if (version === through) return text;
  if (!newer(version, through)) throw new Error(`profile: ${version} is older than verifiedThrough ${through}`);
  const [low, high] = range.split(" - ");
  let out = text;
  if (high !== "*") out = once(out, `"range": "${range}"`, `"range": "${low ?? ""} - ${version}"`, "the range");
  out = once(out, `"verifiedThrough": "${through}"`, `"verifiedThrough": "${version}"`, "verifiedThrough");
  out = once(out, `"verifiedOn": "${on}"`, `"verifiedOn": "${date}"`, "verifiedOn");
  return out;
}

// ── The pass commit ──────────────────────────────────────────────────────────────────────────────

export interface PassInput {
  /** The repo to branch from, as a path. The script runs `git worktree add` there. */
  readonly repo: string;
  readonly labRoot: string;
  readonly harness: string;
  readonly version: string;
  /** `YYYY-MM-DD`. */
  readonly date: string;
  /** The run log, already redacted. It becomes the commit body. */
  readonly log: string;
  /** One line for the ledger row's `evidence`. */
  readonly evidence: string;
}

export interface PassResult {
  readonly branch: string;
  readonly worktree: string;
  readonly commit: string;
  readonly files: readonly string[];
}

export const branchFor = (harness: string, version: string): string => `harness-lab/${harness}-${version}`;
export const BODY_LINES = 160;

export function commitMessage(input: PassInput, profileMoved = true): string {
  const lines = input.log.split("\n");
  const body = lines.length > BODY_LINES ? [...lines.slice(0, BODY_LINES), `... ${String(lines.length - BODY_LINES)} more lines in the run log`] : lines;
  return [
    `Harness lab: ${input.harness} ${input.version} verified`,
    "",
    `The nightly harness lab ran ${input.harness} ${input.version} on ${input.date}.`,
    `Result: ${input.evidence}.`,
    profileMoved ? "This commit moves two files: the verified-versions row and the profile range." : "This commit moves one file: the verified-versions row. The profile range already reaches this version.",
    "",
    "Run log:",
    "",
    ...body,
    "",
  ].join("\n");
}

export function publishPass(input: PassInput, git: Git = realGit): PassResult {
  const branch = branchFor(input.harness, input.version);
  const worktree = join(input.labRoot, "worktrees", `${input.harness}-${input.version}`);
  must(git(input.repo, ["rev-parse", "--verify", "HEAD"]), "rev-parse HEAD");
  if (git(input.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0) throw new Error(`the branch ${branch} exists already`);
  if (existsSync(worktree)) throw new Error(`the worktree ${worktree} exists already`);
  mkdirSync(join(input.labRoot, "worktrees"), { recursive: true });
  must(git(input.repo, ["worktree", "add", "-b", branch, worktree, "HEAD"]), "worktree add");

  try {
    return commitPass(input, git, branch, worktree);
  } catch (err) {
    // A pass that cannot commit leaves no branch and no worktree: they would make the next try refuse with "exists already".
    git(input.repo, ["worktree", "remove", "--force", worktree]);
    git(input.repo, ["branch", "-D", branch]);
    rmSync(worktree, { recursive: true, force: true });
    throw err;
  }
}

function commitPass(input: PassInput, git: Git, branch: string, worktree: string): PassResult {
  const ledgerPath = join(worktree, LEDGER_REL);
  const profilePath = join(worktree, profileRel(input.harness));
  writeFileSync(ledgerPath, withRecord(readFileSync(ledgerPath, "utf8"), { agent: input.harness, version: input.version, verified: input.date, adapter: true, evidence: input.evidence }));
  const profileBefore = readFileSync(profilePath, "utf8");
  const profileAfter = moveProfile(profileBefore, input.version, input.date);
  const profileMoved = profileAfter !== profileBefore;
  if (profileMoved) writeFileSync(profilePath, profileAfter);
  const files = profileMoved ? [LEDGER_REL, profileRel(input.harness)] : [LEDGER_REL];

  must(git(worktree, ["add", "--", ...files]), "add");
  const staged = must(git(worktree, ["diff", "--cached", "--name-only"]), "diff --cached").split("\n").filter((line) => line.length > 0);
  if (staged.length !== files.length || !files.every((file) => staged.includes(file))) throw new Error(`the pass commit must touch only ${files.join(" and ")}, and it staged: ${staged.join(", ")}`);

  const messageFile = join(input.labRoot, "worktrees", `${input.harness}-${input.version}.message`);
  writeFileSync(messageFile, commitMessage(input, profileMoved));
  // A data-only commit: the version guard of the pre-commit hook asks for a CHANGELOG bullet on a
  // functional change, and this one moves a ledger row and a range. The lint guard still runs.
  must(
    git(worktree, ["-c", "user.name=Collie harness lab", "-c", "user.email=harness-lab@localhost", "commit", "--quiet", "-F", messageFile], { SKIP_VERSION_CHECK: "1" }),
    "commit",
  );
  const commit = must(git(worktree, ["rev-parse", "--short", "HEAD"]), "rev-parse");
  return { branch, worktree, commit, files };
}

// ── The fail issue ───────────────────────────────────────────────────────────────────────────────

export interface IssueDraft {
  readonly title: string;
  readonly labels: readonly string[];
  readonly body: string;
}

const MAX_SCREENS = 6;
const MAX_SCREEN_ROWS = 45;
const LOG_TAIL = 60;

function surfaceWord(screen: ScreenFact): string {
  const { turn, modal, composer, reason } = screen.surface;
  return `turn ${turn}, modal ${modal}, composer ${composer}${reason === undefined ? "" : `, reason ${reason}`}`;
}

/** The issue of a failed run. Every screen row and log line passes through {@link redact}. */
export function draftIssue(facts: LabFacts, verdict: Verdict, log: string, counters: readonly string[], context: RedactContext): IssueDraft {
  const title = `Harness drift: ${facts.harness} ${facts.version} fails the nightly lab`;
  const shown = [...verdict.freeOnDialog, ...facts.screens.filter((screen) => isDialogScreen(screen) && !verdict.freeOnDialog.includes(screen))].slice(0, MAX_SCREENS);
  const out: string[] = [];
  out.push(`The nightly harness lab ran ${facts.harness} ${facts.version} and the run failed.`, "", "## Why it failed", "");
  for (const reason of verdict.reasons) out.push(`- ${redact(reason, context)}`);
  out.push("", "## Legs", "");
  if (facts.legs === "phone") out.push("- walk, send and ask: not run, this was a run of the phone leg alone");
  else {
    out.push(`- walk: reached ${String(facts.walk.reached)}, returned to a free box ${String(facts.walk.returned)}, ${String(facts.walk.sent.length)} commands sent`);
    if (facts.walk.unclassified.length > 0) out.push(`- unclassified commands, not sent: ${facts.walk.unclassified.join(" ")}`);
    if (facts.walk.missing.length > 0) out.push(`- safe commands the menu no longer lists: ${facts.walk.missing.join(" ")}`);
    if ((facts.walk.removed ?? []).length > 0) out.push(`- commands the menu marks removed, not sent: ${(facts.walk.removed ?? []).join(" ")}`);
    out.push(facts.send === null ? "- send: not made" : `- send: ${facts.send.outcome}${facts.send.reason === undefined ? "" : ` (${facts.send.reason})`}, ${String(facts.send.keys)} keys`);
    out.push(facts.ask === null ? "- ask: not reached" : `- ask: ${facts.ask.outcome}${facts.ask.reason === undefined ? "" : ` (${facts.ask.reason})`}, declined file made: ${String(facts.ask.fileCreated)}`);
  }
  if (facts.phone === null) out.push(`- phone: did not run${facts.phoneNote === undefined ? "" : `: ${redact(facts.phoneNote, context)}`}`);
  else if (facts.phone !== undefined) for (const line of phoneLines(facts.phone.results)) out.push(`- ${redact(line, context)}`);
  out.push(`- profile status at this version: ${facts.profile}`, `- model turns used: ${String(facts.turns)}`);
  out.push("", "## Surface verdict on every screen", "", "| leg | screen | expected | surface | free | cue |", "| --- | --- | --- | --- | --- | --- |");
  for (const screen of facts.screens) out.push(`| ${screen.leg} | ${redact(screen.label, context)} | ${screen.expects} | ${surfaceWord(screen)} | ${String(screen.free)} | ${screen.cue} |`);
  out.push("", "## Counters", "");
  for (const line of counters.length > 0 ? counters : ["no counter line"]) out.push(`- ${redact(line, context)}`);
  out.push("", "## Redacted screens", "");
  for (const screen of shown) {
    const rows = redactRows(screen.rows, context).slice(-MAX_SCREEN_ROWS);
    out.push(`### ${redact(screen.label, context)} (${surfaceWord(screen)}, free ${String(screen.free)})`, "", "```", ...rows, "```", "");
  }
  const tail = log.split("\n").slice(-LOG_TAIL).join("\n");
  out.push("## Run log, last lines", "", "```", redact(tail, context), "```", "", "The lab never opens a patch. A person reads these screens and fixes the profile or the reader.");
  return { title, labels: [ISSUE_LABEL], body: `${out.join("\n")}\n` };
}

export interface IssueFiles {
  readonly json: string;
  readonly markdown: string;
}

/** Write the issue as `<lab root>/issues/<harness>-<version>.json` (title, labels, body) and `.md` (the body). */
export function writeIssueFiles(labRoot: string, harness: string, version: string, issue: IssueDraft): IssueFiles {
  const dir = join(labRoot, "issues");
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `${harness}-${version}`);
  writeFileSync(`${base}.json`, `${JSON.stringify({ title: issue.title, labels: issue.labels, body: issue.body }, null, 2)}\n`);
  // The Markdown file is the body alone: `gh issue create --body-file` reads it. The title and the label are in the JSON.
  writeFileSync(`${base}.md`, issue.body);
  return { json: `${base}.json`, markdown: `${base}.md` };
}

export type Gh = (args: readonly string[]) => GitResult;

export const realGh: Gh = (args) => {
  const run = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
};

/** Whether the repo has the label. A `gh label list` that fails is an error: a missing label must not be guessed. */
export function labelExists(repoSlug: string, label: string, gh: Gh = realGh): boolean {
  const run = gh(["label", "list", "--repo", repoSlug, "--limit", "200", "--json", "name"]);
  if (run.code !== 0) throw new Error(`gh label list failed (${String(run.code)}): ${run.stderr.trim()}`);
  const parsed = parseJson(run.stdout);
  const names = Array.isArray(parsed) ? parsed : [];
  return names.some((entry) => asJsonString(asJsonObject(entry)?.name) === label);
}

/**
 * `gh issue create`, for a human run with `--open-issue`. The ritual never calls it: a public issue is
 * posted only after Altan has seen the draft. It checks that the label exists first, and says so when it
 * does not, because `gh issue create --label` on a missing label fails after the lab has spent its run.
 * Returns the issue URL.
 */
export function openIssue(files: IssueFiles, issue: IssueDraft, repoSlug: string, gh: Gh = realGh): string {
  for (const label of issue.labels) {
    if (!labelExists(repoSlug, label, gh)) throw new Error(`the label "${label}" does not exist in ${repoSlug}: create it first (gh label create ${label} --repo ${repoSlug}), then post the draft ${files.markdown}`);
  }
  const args = ["issue", "create", "--repo", repoSlug, "--title", issue.title, "--body-file", files.markdown, ...issue.labels.flatMap((label) => ["--label", label])];
  const run = gh(args);
  if (run.code !== 0) throw new Error(`gh issue create failed (${String(run.code)}): ${run.stderr.trim()}`);
  return run.stdout.trim();
}

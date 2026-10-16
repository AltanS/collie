// The lab's command line (M56 spec 10), shared by the nightly entry (main.ts) and the version-change
// entry (../watch.ts). Pure parts first, so the parse and the one-per-version rules are tested.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { FEEDS } from "./feeds";
import { HARNESSES } from "./harnesses";
import { ledgerPath, loadLedger, markNotified, findRow } from "./lab-ledger";
import type { LabOptions, LabOutcome, LabPorts } from "./run";
import { runLab } from "./run";

export interface Candidate {
  readonly harness: string;
  readonly version: string;
  readonly source: string;
}

export interface CliOptions {
  readonly harnesses: readonly string[];
  /** `harness=version` pairs named by hand. They replace the feeds. */
  readonly pairs: readonly { readonly harness: string; readonly version: string }[];
  readonly repo: string;
  readonly labRoot: string;
  readonly ledger: string;
  readonly openIssue: boolean;
  readonly issueRepo: string | null;
  readonly plan: boolean;
  readonly maxRuns: number;
  /** watch.ts only: `harness=version` the installed binary pretends to be. */
  readonly fakeVersions: readonly { readonly harness: string; readonly version: string }[];
}

export const LAB_DIR_ENV = "COLLIE_HARNESS_LAB_DIR";
export const DEFAULT_MAX_RUNS = 4;

export const USAGE = `Usage: bun scripts/harness-canary/lab/main.ts [options]

Reads each harness's release feed. For each (harness, version) that is not in the lab ledger, runs the
lab once: an isolated config, the installed binary at that version, the slash walk, the Surface on every
screen, one probed send and one ask answer. A pass makes a commit on a branch in a scratch worktree. A
fail writes an issue as files. It never pushes. A pair in the ledger is never run again.

  --harness a,b       harnesses to read (default: ${Object.keys(FEEDS).join(",")})
  --version h=x.y.z   run this pair and skip the feeds (comma list allowed)
  --repo PATH         the repo a pass commit branches from (default: this checkout)
  --lab-root DIR      run directories, logs, issues, worktrees (default: ~/.cache/collie-lab/harness-lab,
                      or $${LAB_DIR_ENV})
  --ledger PATH       the lab ledger (default: ~/.local/state/collie-harness-lab/ledger.json, or
                      $COLLIE_HARNESS_LAB_LEDGER)
  --open-issue        run gh issue create on a fail. Only the ritual sets this.
  --issue-repo O/N    the repo for --open-issue (default: the origin of --repo)
  --plan              read the feeds and the ledger, print what would run, run nothing
  --max-runs N        most pairs one invocation runs (default: ${String(DEFAULT_MAX_RUNS)})
  -h, --help          print this`;

export function parsePairs(text: string, flag: string): { harness: string; version: string }[] {
  return text.split(",").map((pair) => {
    const [harness, version] = pair.split("=");
    if (harness === undefined || version === undefined || !/^\d+\.\d+\.\d+$/u.test(version)) throw new Error(`${flag} takes harness=x.y.z, not "${pair}"`);
    if (HARNESSES[harness] === undefined) throw new Error(`${flag}: unknown harness "${harness}" (known: ${Object.keys(HARNESSES).join(", ")})`);
    return { harness, version };
  });
}

export function parseCli(argv: readonly string[], repoRoot: string, env: Readonly<Record<string, string | undefined>> = process.env, home: string = homedir()): CliOptions | "help" {
  let harnesses = Object.keys(FEEDS);
  let pairs: { harness: string; version: string }[] = [];
  let fakeVersions: { harness: string; version: string }[] = [];
  let repo = repoRoot;
  let labRoot = env[LAB_DIR_ENV] !== undefined && env[LAB_DIR_ENV] !== "" ? resolve(env[LAB_DIR_ENV]) : join(home, ".cache", "collie-lab", "harness-lab");
  let ledger = ledgerPath(env, home);
  let open = false;
  let issueRepo: string | null = null;
  let plan = false;
  let maxRuns = DEFAULT_MAX_RUNS;
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "-h":
      case "--help":
        return "help";
      case "--harness":
        harnesses = value(i, arg).split(",");
        for (const harness of harnesses) if (HARNESSES[harness] === undefined) throw new Error(`unknown harness "${harness}" (known: ${Object.keys(HARNESSES).join(", ")})`);
        i++;
        break;
      case "--version":
        pairs = parsePairs(value(i, arg), arg);
        i++;
        break;
      case "--fake-version":
        fakeVersions = parsePairs(value(i, arg), arg);
        i++;
        break;
      case "--repo":
        repo = resolve(value(i, arg));
        i++;
        break;
      case "--lab-root":
        labRoot = resolve(value(i, arg));
        i++;
        break;
      case "--ledger":
        ledger = resolve(value(i, arg));
        i++;
        break;
      case "--open-issue":
        open = true;
        break;
      case "--issue-repo":
        issueRepo = value(i, arg);
        i++;
        break;
      case "--plan":
      case "--dry-run":
        plan = true;
        break;
      case "--max-runs": {
        const n = Number(value(i, arg));
        if (!Number.isInteger(n) || n < 1) throw new Error("--max-runs takes a whole number from 1");
        maxRuns = n;
        i++;
        break;
      }
      default:
        throw new Error(`unknown option "${arg}"`);
    }
  }
  return { harnesses, pairs, repo, labRoot, ledger, openIssue: open, issueRepo, plan, maxRuns, fakeVersions };
}

/** The pairs the ledger has no row for, in the order given, at most `max`. A pair named twice counts once. */
export function pending(candidates: readonly Candidate[], ledgerFile: string, now: number, max: number): Candidate[] {
  const ledger = loadLedger(ledgerFile, now);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.harness}@${candidate.version}`;
    if (seen.has(key) || findRow(ledger, candidate.harness, candidate.version) !== undefined) continue;
    seen.add(key);
    if (out.length < max) out.push(candidate);
  }
  return out;
}

/** The sentence a person is told when a run ends badly. One per (harness, version, verdict). */
export function notifyLine(outcome: LabOutcome): string {
  const where = outcome.issue === undefined ? `log ${outcome.logPath}` : `issue ${outcome.issue.json}`;
  return `harness lab: ${outcome.harness} ${outcome.version} ${outcome.status}: ${outcome.note} (${where})`;
}

export type Notify = (line: string) => void;

export function fileNotify(stateDir: string): Notify {
  return (line) => {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(join(stateDir, "notify.log"), `${new Date().toISOString()} ${line}\n`);
    console.log(`NOTIFY ${line}`);
  };
}

/**
 * Tell the person once per (harness, version, verdict). A pass tells nobody. The ledger row remembers
 * what it told, so a second night with the same verdict is silent (M44 spec 06).
 */
export function tellOnce(ledgerFile: string, outcome: LabOutcome, notify: Notify): boolean {
  if (outcome.status !== "fail" && outcome.status !== "failed") return false;
  const row = findRow(loadLedger(ledgerFile, Date.now()), outcome.harness, outcome.version);
  if (row === undefined || row.notified === outcome.status) return false;
  notify(notifyLine(outcome));
  markNotified(ledgerFile, outcome.harness, outcome.version, outcome.status);
  return true;
}

export interface RunReport {
  readonly outcomes: readonly LabOutcome[];
  readonly told: number;
}

/** Run each pending candidate once, in order. Never throws for one pair's end. */
export async function runCandidates(candidates: readonly Candidate[], cli: CliOptions, ports: LabPorts, notify: Notify, now: () => number = () => Date.now()): Promise<RunReport> {
  const outcomes: LabOutcome[] = [];
  let told = 0;
  for (const candidate of pending(candidates, cli.ledger, now(), cli.maxRuns)) {
    const options: LabOptions = {
      harness: candidate.harness,
      version: candidate.version,
      repo: cli.repo,
      labRoot: cli.labRoot,
      ledgerPath: cli.ledger,
      openIssue: cli.openIssue,
      issueRepo: cli.issueRepo ?? undefined,
      now,
    };
    const outcome = await runLab(options, ports);
    outcomes.push(outcome);
    if (tellOnce(cli.ledger, outcome, notify)) told++;
  }
  return { outcomes, told };
}

export function summaryLine(outcome: LabOutcome): string {
  return `${outcome.harness} ${outcome.version}: ${outcome.status}: ${outcome.note}`;
}

/** The exit code: 1 when a run failed or could not finish. A skip, a deferral and a pass are 0. */
export function exitCodeOf(outcomes: readonly LabOutcome[]): number {
  return outcomes.some((outcome) => outcome.status === "fail" || outcome.status === "failed") ? 1 : 0;
}

export function stateDirOf(ledgerFile: string): string {
  return dirname(ledgerFile);
}

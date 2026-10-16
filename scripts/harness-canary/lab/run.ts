// One lab run, start to end (M56 spec 10): the order of the steps and what each end writes down.
// The hands (npm, tmux, the protocol, git) are ports, so a test runs the whole order with fakes.
//
//   1. skip      a pair with a ledger row is skipped, in every result. This is the stop rule.
//   2. preflight a tool or a login that is not ready defers the run. Nothing was spent, no row is written.
//   3. claim     the `running` row, written before the first paid step.
//   4. install   the binary at that version, into the run directory. One retry: it costs no model turn.
//   5. session   the walk, the Surface over every screen, one probed send, one ask answer.
//   6. judge     pass, fail or walk-only (verdict.ts).
//   7. publish   pass: a commit on a branch in a scratch worktree. fail: the issue as files.
//   8. settle    the row gets its result. A run that cannot finish gets `failed`.
//   9. clean up  the run directory is deleted, with the login copy in it.
//
// Nothing here pushes, and nothing opens an issue unless `openIssue` is set.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact, redactContext, type RedactContext } from "./redact";
import { claim, expireStale, loadLedger, readLedger, settle, shouldRun, type LabResult, type LabRow } from "./lab-ledger";
import { harnessSpec, runDirs, type HarnessSpec, type RunDirs } from "./harnesses";
import { draftIssue, writeIssueFiles, type IssueFiles, type PassInput, type PassResult } from "./publish";
import { LabDeferred } from "./seed";
import { judge, type LabFacts, type Verdict } from "./verdict";

/** What a session returns: the facts, the counter lines, and what the session logged. */
export interface SessionFacts {
  readonly facts: Omit<LabFacts, "harness" | "version">;
  readonly counters: readonly string[];
}

export interface LabPorts {
  /** Is everything the run needs ready? Throws {@link LabDeferred} when not. Writes nothing paid. */
  preflight(spec: HarnessSpec, dirs: RunDirs): Promise<void>;
  /** The binary at the version, installed under `dirs.bin`. Returns the version the binary printed. */
  install(spec: HarnessSpec, dirs: RunDirs, version: string, log: (line: string) => void): Promise<string>;
  /** The walk and the legs, in a throwaway tmux. Cleans its tmux server before it returns or throws. */
  session(spec: HarnessSpec, dirs: RunDirs, version: string, log: (line: string) => void): Promise<SessionFacts>;
  publishPass(input: PassInput): PassResult;
  openIssue(files: IssueFiles, issue: { title: string; labels: readonly string[]; body: string }, repoSlug: string): string;
}

export interface LabOptions {
  readonly harness: string;
  readonly version: string;
  /** The repo a pass commit branches from. */
  readonly repo: string;
  /** `~/.cache/collie-lab/harness-lab`. Holds the run directories, the logs, the issues and the worktrees. */
  readonly labRoot: string;
  readonly ledgerPath: string;
  /** Run `gh issue create` on a fail. Only the ritual sets it. */
  readonly openIssue: boolean;
  /** `owner/name`, for `gh issue create`. Needed only with `openIssue`. */
  readonly issueRepo?: string | undefined;
  readonly now?: (() => number) | undefined;
  /** For a test: the context redaction uses. */
  readonly redaction?: RedactContext | undefined;
}

export type LabStatus = "skipped" | "deferred" | LabResult;

export interface LabOutcome {
  readonly harness: string;
  readonly version: string;
  readonly status: LabStatus;
  readonly note: string;
  readonly logPath: string;
  readonly verdict?: Verdict;
  readonly pass?: PassResult;
  readonly issue?: IssueFiles;
  readonly issueUrl?: string;
}

export function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function runRoot(labRoot: string, harness: string, version: string): string {
  return join(labRoot, `${harness}-${version}`);
}

export function logPathOf(labRoot: string, harness: string, version: string): string {
  return join(labRoot, "logs", `${harness}-${version}.log`);
}

/** Retry once. Used for the install only: it costs no model turn, so it repeats no paid action. */
async function twice<T>(what: string, log: (line: string) => void, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (first) {
    log(`${what} failed (${first instanceof Error ? first.message : String(first)}), trying once more`);
    return run();
  }
}

export async function runLab(options: LabOptions, ports: LabPorts): Promise<LabOutcome> {
  const now = options.now ?? ((): number => Date.now());
  const { harness, version } = options;
  const spec = harnessSpec(harness);
  const logPath = logPathOf(options.labRoot, harness, version);
  const dirs = runDirs(runRoot(options.labRoot, harness, version));
  const context = options.redaction ?? redactContext([dirs.root, options.labRoot]);
  const lines: string[] = [];
  const log = (line: string): void => {
    lines.push(`${new Date(now()).toISOString()} ${line}`);
  };
  const outcome = (status: LabStatus, note: string, extra: Partial<LabOutcome> = {}): LabOutcome => ({ harness, version, status, note, logPath, ...extra });
  const writeLog = (): void => {
    mkdirSync(join(options.labRoot, "logs"), { recursive: true });
    writeFileSync(logPath, `${redact(lines.join("\n"), context)}\n`);
  };

  // 1. The stop rule.
  const existing = loadLedger(options.ledgerPath, now());
  if (!shouldRun(existing, harness, version)) {
    const row = existing.rows.find((candidate) => candidate.harness === harness && candidate.version === version);
    return outcome("skipped", `already in the ledger as ${row?.result ?? "?"} on ${row?.date ?? "?"}`);
  }

  // 2. Preflight: nothing is spent and no row is written when the run cannot start.
  const cleanup = (): void => {
    rmSync(dirs.root, { recursive: true, force: true });
  };
  try {
    mkdirSync(dirs.root, { recursive: true, mode: 0o700 });
    await ports.preflight(spec, dirs);
  } catch (err) {
    cleanup();
    const note = err instanceof Error ? err.message : String(err);
    log(`deferred: ${note}`);
    writeLog();
    if (err instanceof LabDeferred) return outcome("deferred", note);
    throw err;
  }

  // 3. The claim. After this line the pair has a row for good.
  if (!claim(options.ledgerPath, harness, version, today(now()), logPath, now())) {
    cleanup();
    return outcome("skipped", "another run holds this pair");
  }
  log(`lab ${harness} ${version}: claimed`);

  // 4 to 8. Every end below settles the row.
  const finish = (result: Exclude<LabResult, "running">, note: string, extra: Partial<LabOutcome> = {}): LabOutcome => {
    log(`lab ${harness} ${version}: ${result}: ${note}`);
    settle(options.ledgerPath, harness, version, { result, note });
    cleanup();
    writeLog();
    return outcome(result, note, extra);
  };

  try {
    const printed = await twice("install", log, () => ports.install(spec, dirs, version, log));
    log(`installed ${harness} ${printed}`);
    const session = await ports.session(spec, dirs, version, log);
    const facts: LabFacts = { harness, version, ...session.facts };
    const verdict = judge(facts);
    log(`verdict: ${verdict.result}${verdict.reasons.length > 0 ? `: ${verdict.reasons.join("; ")}` : ""}`);
    for (const line of session.counters) log(`counter: ${line}`);

    if (verdict.result === "walk-only") return finish("walk-only", "only the walk ran: this harness has no profile", { verdict });

    if (verdict.result === "pass") {
      const evidence = `harness lab ${today(now())} on ${harness} ${version}: walk, Surface on ${String(facts.screens.length)} screens, one probed send, one ask answer; ${String(facts.turns)} model turns`;
      try {
        // The log goes into the commit body as it stands now, redacted.
        const body = redact(lines.join("\n"), context);
        const pass = ports.publishPass({ repo: options.repo, labRoot: options.labRoot, harness, version, date: today(now()), log: body, evidence });
        return finish("pass", `branch ${pass.branch} at ${pass.commit}`, { verdict, pass });
      } catch (err) {
        const note = `passed, and the commit failed: ${err instanceof Error ? err.message : String(err)}`;
        return finish("pass", note, { verdict });
      }
    }

    // A fail: the issue as files. `gh issue create` only on request.
    const issue = draftIssue(facts, verdict, lines.join("\n"), session.counters, context);
    const files = writeIssueFiles(options.labRoot, harness, version, issue);
    log(`issue written: ${files.json}`);
    let url: string | undefined;
    let openNote = "";
    if (options.openIssue) {
      try {
        if (options.issueRepo === undefined) throw new Error("--open-issue needs an issue repo (--issue-repo owner/name)");
        url = ports.openIssue(files, issue, options.issueRepo);
        log(`issue opened: ${url}`);
      } catch (err) {
        openNote = `; the issue was not opened: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    return finish("fail", `${verdict.reasons.join("; ")}${openNote}`, { verdict, issue: files, issueUrl: url });
  } catch (err) {
    return finish("failed", err instanceof Error ? err.message : String(err));
  }
}

/** For a caller that needs to know the ledger without running anything: the rows, stale ones settled. */
export function peekLedger(path: string, now: number): readonly LabRow[] {
  return expireStale(readLedger(path), now).ledger.rows;
}

export function leftoverRunDir(labRoot: string, harness: string, version: string): boolean {
  return existsSync(runRoot(labRoot, harness, version));
}

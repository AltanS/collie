// One lab run, start to end (M56 spec 10): the order of the steps and what each end writes down.
// The hands (npm, tmux, the protocol, git) are ports, so a test runs the whole order with fakes.
//
//   1. skip      a pair with a ledger row is skipped, in every result. This is the stop rule. A run that
//                names its version by hand reruns a `failed` row (no verdict), and only that.
//   2. preflight a tool or a login that is not ready defers the run. Nothing was spent, no row is written.
//   3. claim     the `running` row, written before the first paid step.
//   4. install   the binary at that version, into the run directory. One retry: it costs no model turn.
//   5. session   the walk, the Surface over every screen, one probed send, one ask answer, then the
//                phone leg (phone.ts): a scratch bridge driven over HTTP, the way the phone drives one.
//   6. judge     pass, fail or walk-only (verdict.ts).
//   7. publish   pass: a commit on a branch in a scratch worktree. fail: the issue as files.
//   8. settle    the row gets its result. A run that cannot finish gets `failed`.
//   9. clean up  the run directory is deleted, with the login copy in it.
//
// The login copy must never outlive the run. Before step 1 the sweep (sweep.ts) removes the folders and
// the tmux servers that an earlier run left. During the run a SIGTERM, a SIGINT or an uncaught error
// deletes the run directory first, then stops the tmux server and writes a `failed` row, then exits.
//
// Nothing here pushes, and nothing opens an issue unless `openIssue` is set.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact, redactContext, type RedactContext } from "./redact";
import { claim, expireStale, loadLedger, readLedger, settle, shouldRun, type LabResult, type LabRow } from "./lab-ledger";
import { sweepLab, type Liveness } from "./sweep";
import { harnessSpec, runDirs, type HarnessSpec, type RunDirs } from "./harnesses";
import { draftIssue, writeIssueFiles, type IssueFiles, type PassInput, type PassResult } from "./publish";
import { LabDeferred } from "./seed";
import { judge, type LabFacts, type LabLegs, type Verdict } from "./verdict";
import { phoneCount } from "./phone-verdict";

/** What a session returns: the facts, the counter lines, and what the session logged. */
export interface SessionFacts {
  readonly facts: Omit<LabFacts, "harness" | "version">;
  readonly counters: readonly string[];
}

/** What the session is asked to do beyond the walk: which legs, where the phone leg writes, which bridge it drives. */
export interface SessionPlan {
  readonly legs: LabLegs;
  /** A bridge that already runs, for the phone leg alone (`--bridge`). Absent: the phone leg starts a scratch bridge. */
  readonly bridge?: { readonly url: string; readonly token: string } | undefined;
  /** The phone leg's run folder: captures and summary.json. It outlives the run directory. */
  readonly phoneOut: string;
  /** Redaction for every capture and summary the phone leg writes. */
  readonly redact: (text: string) => string;
}

export interface LabPorts {
  /** Is everything the run needs ready? Throws {@link LabDeferred} when not. Writes nothing paid. */
  preflight(spec: HarnessSpec, dirs: RunDirs): Promise<void>;
  /** The binary at the version, installed under `dirs.bin`. Returns the version the binary printed. */
  install(spec: HarnessSpec, dirs: RunDirs, version: string, log: (line: string) => void): Promise<string>;
  /** The walk and the legs, in a throwaway tmux. Cleans its tmux server before it returns or throws. */
  session(spec: HarnessSpec, dirs: RunDirs, version: string, log: (line: string) => void, plan: SessionPlan): Promise<SessionFacts>;
  /** Stop the tmux server of the session that is running now, if any. Never throws. Used on a signal. */
  stopAll(): Promise<void>;
  /** Who is alive, and which lab tmux servers exist. The sweep asks. */
  readonly liveness: Liveness;
  /** The lab's own clone of the repo, reset to origin/main. The pass branch comes from it. Throws on a refused repo. */
  clone(source: string, labRoot: string): string;
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
  /** False for a dry run: a pass settles the row and makes no commit. */
  readonly publish?: boolean | undefined;
  /** For a test: where SIGTERM, SIGINT and uncaught errors come from. */
  readonly signals?: SignalSource | undefined;
  /** For a test: the context redaction uses. */
  readonly redaction?: RedactContext | undefined;
  /** Absent means `all`. A phone-only run never makes a pass commit. */
  readonly legs?: LabLegs | undefined;
  /** The version was named by hand (`--version`): a `failed` row for the pair does not stop the run (lab-ledger.ts, `shouldRun`). */
  readonly named?: boolean | undefined;
  /** A bridge that already runs, for a phone-only run (`--bridge` and `--token-file`). */
  readonly bridge?: { readonly url: string; readonly token: string } | undefined;
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

/** Where the emergency comes from. A test gives it a fake, so no test kills a process. */
export interface SignalSource {
  /** Calls `handler(reason)` on SIGTERM, SIGINT and an uncaught error. Returns the call that takes it off again. */
  install(handler: (reason: string) => Promise<void>): () => void;
}

export const processSignals: SignalSource = {
  install(handler) {
    const end = (reason: string, code: number): void => {
      void handler(reason).finally(() => process.exit(code));
    };
    const onTerm = (): void => end("interrupted by SIGTERM", 143);
    const onInt = (): void => end("interrupted by SIGINT", 130);
    const onError = (error: Error): void => end(`uncaughtException: ${error.message}`, 1);
    const onReject = (reason: Error): void => end(`unhandledRejection: ${reason.message}`, 1);
    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onInt);
    process.on("uncaughtException", onError);
    process.on("unhandledRejection", onReject);
    return () => {
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
      process.off("uncaughtException", onError);
      process.off("unhandledRejection", onReject);
    };
  },
};

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

  // 0. The sweep: what an earlier run left behind. This runs before the stop rule, so even a skipped pair cleans up.
  try {
    const swept = await sweepLab({ labRoot: options.labRoot, ledgerPath: options.ledgerPath, now: now(), live: ports.liveness });
    for (const name of swept.removed) log(`sweep: removed the run folder of ${name}`);
    for (const name of swept.killed) log(`sweep: killed the tmux server ${name}`);
    for (const name of swept.settled) log(`sweep: ${name} was running and its process is dead, so the row is failed`);
  } catch (err) {
    log(`sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 1. The stop rule.
  const existing = loadLedger(options.ledgerPath, now());
  if (!shouldRun(existing, harness, version, options.named === true)) {
    const row = existing.rows.find((candidate) => candidate.harness === harness && candidate.version === version);
    return outcome("skipped", `already in the ledger as ${row?.result ?? "?"} on ${row?.date ?? "?"}`);
  }

  const cleanup = (): void => {
    rmSync(dirs.root, { recursive: true, force: true });
  };
  // An emergency ends the run: the folder (with the login copy) deleted first, then tmux stopped, the row failed.
  let claimed = false;
  let ended = false;
  const emergency = async (reason: string): Promise<void> => {
    if (ended) return;
    ended = true;
    log(`lab ${harness} ${version}: emergency: ${reason}`);
    // The folder with the login copy goes first. A SIGKILL that follows the SIGTERM may arrive while tmux stops.
    cleanup();
    try {
      await ports.stopAll();
    } catch {
      // The server may be gone already.
    }
    if (claimed) {
      try {
        settle(options.ledgerPath, harness, version, { result: "failed", note: reason });
      } catch (err) {
        log(`the row could not be settled: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    writeLog();
  };
  const uninstall = (options.signals ?? processSignals).install(emergency);
  try {
    // 2. Preflight: nothing is spent and no row is written when the run cannot start.
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
    if (!claim(options.ledgerPath, harness, version, today(now()), logPath, now(), undefined, options.named === true)) {
      cleanup();
      return outcome("skipped", "another run holds this pair");
    }
    claimed = true;
    log(`lab ${harness} ${version}: claimed`);

    // 4 to 8. Every end below settles the row.
    const finish = (result: Exclude<LabResult, "running">, note: string, extra: Partial<LabOutcome> = {}): LabOutcome => {
      if (ended) return outcome("failed", "the run was ended by a signal or an uncaught error");
      ended = true;
      log(`lab ${harness} ${version}: ${result}: ${note}`);
      settle(options.ledgerPath, harness, version, { result, note });
      cleanup();
      writeLog();
      return outcome(result, note, extra);
    };

    try {
      const cutShort = (): LabOutcome => outcome("failed", "the run was ended by a signal or an uncaught error");
      const printed = await twice("install", log, () => ports.install(spec, dirs, version, log));
      if (ended) return cutShort();
      log(`installed ${harness} ${printed}`);
      const legs: LabLegs = options.legs ?? "all";
      const stamp = new Date(now()).toISOString().replace(/[:.]/gu, "-");
      const plan: SessionPlan = { legs, bridge: options.bridge, phoneOut: join(options.labRoot, "phone", `${harness}-${version}-${stamp}`), redact: (text) => redact(text, context) };
      const session = await ports.session(spec, dirs, version, log, plan);
      // A signal that came during the session has stopped tmux and settled the row. Nothing more may happen.
      if (ended) return cutShort();
      const facts: LabFacts = { harness, version, legs, ...session.facts };
      const verdict = judge(facts);
      log(`verdict: ${verdict.result}${verdict.reasons.length > 0 ? `: ${verdict.reasons.join("; ")}` : ""}`);
      for (const line of session.counters) log(`counter: ${line}`);

      if (verdict.result === "walk-only") return finish("walk-only", "only the walk ran: this harness has no profile", { verdict });

      if (verdict.result === "pass") {
        const send = facts.send;
        const ask = facts.ask;
        const phone = facts.phone === undefined || facts.phone === null ? "" : `, the phone leg over HTTP (${phoneCount(facts.phone.results)})`;
        const evidence = `harness lab ${today(now())} on ${harness} ${version}: walk, Surface on ${String(facts.screens.length)} screens, one probed send (${send?.outcome ?? "none"}), one ask answer (${ask?.outcome ?? "none"}, declined file made: ${String(ask?.fileCreated ?? false)})${phone}; ${String(facts.turns)} model turns`;
        // A phone leg alone never verifies a version: the walk and the readers did not run.
        if (legs !== "all") return finish("pass", `phone-only run: no commit; the phone leg passed (${facts.phone === undefined || facts.phone === null ? "no result" : phoneCount(facts.phone.results)})`, { verdict });
        if (options.publish === false) return finish("pass", "dry run: no commit was made", { verdict });
        try {
          // The log goes into the commit body as it stands now, redacted.
          const body = redact(lines.join("\n"), context);
          const repo = ports.clone(options.repo, options.labRoot);
          const pass = ports.publishPass({ repo, labRoot: options.labRoot, harness, version, date: today(now()), log: body, evidence });
          return finish("pass", `branch ${pass.branch} at ${pass.commit}`, { verdict, pass });
        } catch (err) {
          // A pass with no commit is not a verified version, so the row says failed and says why.
          return finish("failed", `the lab passed and the pass commit failed: ${err instanceof Error ? err.message : String(err)}`, { verdict });
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
  } finally {
    uninstall();
    // Whatever happened above, the run folder and the login copy in it do not outlive the run.
    cleanup();
  }
}

/** For a caller that needs to know the ledger without running anything: the rows, stale ones settled. */
export function peekLedger(path: string, now: number): readonly LabRow[] {
  return expireStale(readLedger(path), now).ledger.rows;
}

export function leftoverRunDir(labRoot: string, harness: string, version: string): boolean {
  return existsSync(runRoot(labRoot, harness, version));
}

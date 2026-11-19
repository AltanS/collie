// The lab's command line (M56 spec 10), shared by the nightly entry (main.ts) and the version-change
// entry (../watch.ts). Pure parts first, so the parse and the one-per-version rules are tested.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { realLiveness, sweepLab, type Liveness } from "./sweep";
import { checkSource, defaultLabRoot, LAB_DIR_ENV } from "./clone";
import { FEEDS } from "./feeds";
import { HARNESSES } from "./harnesses";
import { ledgerPath, loadLedger, markNotified, findRow, shouldRun } from "./lab-ledger";
import type { LabOptions, LabOutcome, LabPorts } from "./run";
import { runLab } from "./run";
import { LAB_LEGS, type LabLegs } from "./verdict";
import { LOAD_LIMIT } from "./load-guard";

export interface Candidate {
  /** True when a person named the pair with `--version`: a `failed` ledger row does not skip it. */
  readonly named?: boolean | undefined;
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
  /** False with `--no-publish`: a pass settles the row and makes no commit. */
  readonly publish: boolean;
  readonly plan: boolean;
  readonly maxRuns: number;
  /** watch.ts only: `harness=version` the installed binary pretends to be. */
  readonly fakeVersions: readonly { readonly harness: string; readonly version: string }[];
  /** `all` (the default) or `phone` alone (`--leg phone`). */
  readonly legs: LabLegs;
  /** `--bridge URL --token-file PATH`: the phone leg against a bridge that already runs. Null: a scratch bridge. */
  readonly bridge: { readonly url: string; readonly tokenFile: string } | null;
  /** The harnesses this invocation may plan or run (`--agents`, or `--loop`). Null: every harness the lab knows. Nothing outside it is planned, run or spent. */
  readonly agents: readonly string[] | null;
  /** `--loop`: the daily drift loop (free agents only, two runs a tick, the load guard, a limit per pair). */
  readonly loop: boolean;
  /** The 1-minute load average above which a run does nothing and exits 0. 0: no guard. */
  readonly maxLoad: number;
  /** The most one pair may take, in ms. Undefined: no limit beyond each step's own wait. */
  readonly pairTimeoutMs: number | undefined;
}

/**
 * The agents the drift loop may run (owner's decision, 2026-11-19): the free ones. Claude Code runs on the
 * subscription, OpenCode on its free model. No paid agent runs unattended: omp spends OpenRouter credit, Codex
 * spends an OpenAI key. Those run by hand, without `--loop`.
 */
export const LOOP_AGENTS: readonly string[] = ["claude", "opencode"];
export const LOOP_MAX_RUNS = 2;
export const LOOP_PAIR_TIMEOUT_MS = 15 * 60_000;

/** The suffix a phone-only run puts on its lab root and its ledger, so it never blocks or sweeps the nightly run. */
export const PHONE_ONLY_SUFFIX = "leg-phone";

/**
 * The lab root of a phone-only run: one folder per ledger under `<lab root>/leg-phone/`. A run's start
 * sweep deletes every run folder its own ledger has no live row for, so two hand runs with two ledgers
 * in one folder delete each other's run folder mid-run (2026-10-17: the scratch bridge lost its state
 * and answered 403). The folder name (`ledger-<hash>`) is no run folder name, so no sweep takes it.
 */
export function phoneOnlyRoot(labRoot: string, ledger: string): string {
  return join(labRoot, PHONE_ONLY_SUFFIX, `ledger-${createHash("sha256").update(resolve(ledger)).digest("hex").slice(0, 10)}`);
}

/** A `--bridge` URL: http on this machine, a port, no path. The start line names the lab's binary by path. */
export function parseBridgeUrl(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`--bridge takes a URL like http://127.0.0.1:8788, not "${text}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`--bridge takes an http URL, not "${text}"`);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("--bridge must name a bridge on this machine (127.0.0.1 or localhost): the phone leg starts the lab's own binary by its path");
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") throw new Error(`--bridge takes the bridge's origin with no path, not "${text}"`);
  return url.origin;
}

export const DEFAULT_MAX_RUNS = 4;

export const USAGE = `Usage: bun scripts/harness-canary/lab/main.ts [options]

Reads each harness's release feed. For each (harness, version) that is not in the lab ledger, runs the
lab once: an isolated config, the installed binary at that version, the slash walk, the Surface on every
screen, one probed send and one ask answer. A pass makes a commit on a branch in a scratch worktree. A
fail writes an issue as files. It never pushes. A pair in the ledger is never run again, except that
a pair you name with --version runs again when its row says "failed" (no verdict).

  --harness a,b       harnesses to read (default: ${Object.keys(FEEDS).join(",")})
  --version h=x.y.z   run this pair and skip the feeds (comma list allowed)
  --repo PATH         the repo whose origin the lab clones (default: this checkout). The lab never writes
                      into it. The pass branch comes from the lab's own clone under the lab root. A path
                      under ~/apps and a checkout with a detached HEAD are refused.
  --lab-root DIR      run directories, logs, issues, worktrees (default: ~/.cache/collie-lab/harness-lab,
                      or $${LAB_DIR_ENV})
  --ledger PATH       the lab ledger (default: ~/.local/state/collie-harness-lab/ledger.json, or
                      $COLLIE_HARNESS_LAB_LEDGER)
  --open-issue        run gh issue create on a fail, after it checks that the label exists. A person sets
                      this. The ritual never does: a public issue is posted after Altan has seen the draft.
  --issue-repo O/N    the repo for --open-issue
  --no-publish        a pass settles the row and makes no commit (a dry run of the legs)
  --plan              read the feeds and the ledger, print what would run, run nothing
  --max-runs N        most pairs one invocation runs (default: ${String(DEFAULT_MAX_RUNS)})
  --agents a,b        only these harnesses are planned or run, whatever the feeds or --version name. A pair
                      outside the list is refused. Default: every harness the lab knows
  --loop              the daily drift loop: --agents ${LOOP_AGENTS.join(",")} (only free agents are allowed with it),
                      --max-runs ${String(LOOP_MAX_RUNS)}, --max-load ${String(LOAD_LIMIT)}, --pair-timeout-min ${String(LOOP_PAIR_TIMEOUT_MS / 60_000)}.
                      An environment failure (registry, login, load, timeout) is a retry row, not a final one
  --max-load N        a run with a 1-minute load average above N does nothing, logs one line and exits 0
                      (0 turns the guard off; default ${String(LOAD_LIMIT)} with --loop, off otherwise)
  --pair-timeout-min N  a pair that takes longer is stopped and retried (default ${String(LOOP_PAIR_TIMEOUT_MS / 60_000)} with --loop, off otherwise)
  --leg all|phone     all legs (default), or the phone leg alone: a hand run that needs one --version,
                      makes no commit, and keeps its own ledger and run folders (${PHONE_ONLY_SUFFIX})
  --bridge URL        with --leg phone: drive this running bridge on this machine instead of a scratch
                      bridge. The leg makes its own panes, touches no other, and closes them at the end.
  --token-file PATH   with --bridge: a file holding a device token the operator paired by hand
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
  let labRoot = resolve(defaultLabRoot(env, home));
  let ledger = ledgerPath(env, home);
  let open = false;
  let issueRepo: string | null = null;
  let publish = true;
  let plan = false;
  let maxRuns = DEFAULT_MAX_RUNS;
  let legs: LabLegs = "all";
  let bridgeUrl: string | null = null;
  let tokenFile: string | null = null;
  let agents: string[] | null = null;
  let loop = false;
  let maxLoad: number | null = null;
  let pairMinutes: number | null = null;
  let maxRunsGiven = false;
  let harnessesGiven = false;
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
        harnessesGiven = true;
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
      case "--no-publish":
        publish = false;
        break;
      case "--plan":
      case "--dry-run":
        plan = true;
        break;
      case "--max-runs": {
        const n = Number(value(i, arg));
        if (!Number.isInteger(n) || n < 1) throw new Error("--max-runs takes a whole number from 1");
        maxRuns = n;
        maxRunsGiven = true;
        i++;
        break;
      }
      case "--agents":
        agents = value(i, arg).split(",");
        for (const agent of agents) if (HARNESSES[agent] === undefined) throw new Error(`--agents: unknown harness "${agent}" (known: ${Object.keys(HARNESSES).join(", ")})`);
        i++;
        break;
      case "--loop":
        loop = true;
        break;
      case "--max-load": {
        const n = Number(value(i, arg));
        if (!Number.isFinite(n) || n < 0) throw new Error("--max-load takes a number from 0 (0 turns the guard off)");
        maxLoad = n;
        i++;
        break;
      }
      case "--pair-timeout-min": {
        const n = Number(value(i, arg));
        if (!Number.isFinite(n) || n <= 0) throw new Error("--pair-timeout-min takes a number above 0");
        pairMinutes = n;
        i++;
        break;
      }
      case "--leg": {
        const named = value(i, arg);
        const found = LAB_LEGS.find((leg) => leg === named);
        if (found === undefined) throw new Error(`--leg takes ${LAB_LEGS.join(" or ")}, not "${named}"`);
        legs = found;
        i++;
        break;
      }
      case "--bridge":
        bridgeUrl = parseBridgeUrl(value(i, arg));
        i++;
        break;
      case "--token-file":
        tokenFile = resolve(value(i, arg));
        i++;
        break;
      default:
        throw new Error(`unknown option "${arg}"`);
    }
  }
  if (fakeVersions.length > 0 && !plan) throw new Error("--fake-version needs --dry-run: a fake version must never start a real run");
  if ((bridgeUrl === null) !== (tokenFile === null)) throw new Error("--bridge and --token-file go together");
  if (bridgeUrl !== null && legs !== "phone") throw new Error("--bridge runs the phone leg alone: add --leg phone");
  if (legs === "phone") {
    if (!plan && pairs.length !== 1) throw new Error("--leg phone is a hand run of one version: name it with --version harness=x.y.z");
    for (const pair of pairs) if (HARNESSES[pair.harness]?.phone !== true) throw new Error(`--leg phone runs Claude only, not ${pair.harness}`);
    // Its own lab root and ledger: a phone-only row never blocks the nightly run, and neither run's sweep removes the other's folders.
    ledger = ledger.endsWith(".json") ? `${ledger.slice(0, -".json".length)}.${PHONE_ONLY_SUFFIX}.json` : `${ledger}.${PHONE_ONLY_SUFFIX}`;
    labRoot = phoneOnlyRoot(labRoot, ledger);
  }
  const bridge = bridgeUrl === null || tokenFile === null ? null : { url: bridgeUrl, tokenFile };
  if (loop) {
    // The loop runs unattended, so it may spend only what is free. A paid agent is never in it.
    agents ??= [...LOOP_AGENTS];
    for (const agent of agents) if (!LOOP_AGENTS.includes(agent)) throw new Error(`--loop runs the free agents only (${LOOP_AGENTS.join(", ")}), not ${agent}: a paid agent runs by hand, without --loop`);
    if (!maxRunsGiven) maxRuns = LOOP_MAX_RUNS;
    if (legs !== "all" || bridge !== null) throw new Error("--loop runs every leg on a scratch bridge: it does not take --leg phone or --bridge");
  }
  if (agents !== null) {
    if (!harnessesGiven) harnesses = [...agents];
    for (const harness of harnesses) if (!agents.includes(harness)) throw new Error(`--harness ${harness} is outside --agents ${agents.join(",")}`);
    for (const pair of pairs) if (!agents.includes(pair.harness)) throw new Error(`--version ${pair.harness}=${pair.version} is outside --agents ${agents.join(",")}`);
  }
  const pairTimeoutMs = pairMinutes === null ? (loop ? LOOP_PAIR_TIMEOUT_MS : undefined) : pairMinutes * 60_000;
  return { harnesses, pairs, repo, labRoot, ledger, openIssue: open, issueRepo, publish, plan, maxRuns, fakeVersions, legs, bridge, agents, loop, maxLoad: maxLoad ?? (loop ? LOAD_LIMIT : 0), pairTimeoutMs };
}

/** The pairs the ledger has no row for, in the order given, at most `max`. A pair named twice counts once. A named pair with a `failed` row counts as pending too. */
export function pending(candidates: readonly Candidate[], ledgerFile: string, now: number, max: number): Candidate[] {
  const ledger = loadLedger(ledgerFile, now);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.harness}@${candidate.version}`;
    if (seen.has(key) || !shouldRun(ledger, candidate.harness, candidate.version, candidate.named === true, now)) continue;
    seen.add(key);
    if (out.length < max) out.push(candidate);
  }
  return out;
}

/** The candidates of the allowlist. Null: all of them. A paid agent that no list names is never planned, run or spent. */
export function allowed(candidates: readonly Candidate[], agents: readonly string[] | null): Candidate[] {
  return agents === null ? [...candidates] : candidates.filter((candidate) => agents.includes(candidate.harness));
}

/** The sentence a person is told when a run ends badly. One per (harness, version, verdict). */
export function notifyLine(outcome: LabOutcome): string {
  const where = outcome.issue === undefined ? `log ${outcome.logPath}` : `issue ${outcome.issue.json}`;
  return `harness lab: ${outcome.harness} ${outcome.version} ${outcome.status}: ${outcome.note} (${where})`;
}

export type Notify = (line: string) => void;

/** The same line inside this window is written once: a loop must not repeat a notice on every tick. */
export const NOTIFY_DEDUPE_MS = 12 * 60 * 60 * 1000;

export interface NotifyOptions {
  readonly now?: () => number;
}

/**
 * Tell the person, locally. Every line goes to the console and to `notify.log` in the state folder. The same
 * line inside {@link NOTIFY_DEDUPE_MS} is written once. Nothing is posted anywhere public.
 */
export function fileNotify(stateDir: string, options: NotifyOptions = {}): Notify {
  const now = options.now ?? ((): number => Date.now());
  return (line) => {
    console.log(`NOTIFY ${line}`);
    mkdirSync(stateDir, { recursive: true });
    const file = join(stateDir, "notify.log");
    const last = existsSync(file) ? readFileSync(file, "utf8").trimEnd().split("\n").pop() ?? "" : "";
    const [stamp, ...rest] = last.split(" ");
    if (rest.join(" ") === line && now() - Date.parse(stamp ?? "") < NOTIFY_DEDUPE_MS) return;
    appendFileSync(file, `${new Date(now()).toISOString()} ${line}\n`);
  };
}

/** The darius project the candles belong to. Passed as `--project`, so the timer's own working directory does not matter. */
export const CANDLE_PROJECT = "collie-workspace";

/** A candle the loop asks darius to light: one problem that needs the operator. */
export interface Candle {
  readonly key: string;
  readonly title: string;
  readonly body: string;
}

/** Runs a command with a text on stdin. Injected, so a test never lights a real candle. */
export type CommandRunner = (argv: readonly string[], stdin: string) => { readonly code: number; readonly out: string };

export const realRunner: CommandRunner = (argv, stdin) => {
  const done = Bun.spawnSync([...argv], { stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  return { code: done.exitCode, out: `${done.stdout.toString()}${done.stderr.toString()}`.trim() };
};

const HARNESS_NAMES = new Map([["claude", "Claude Code"], ["opencode", "OpenCode"], ["codex", "Codex"]]);

/** The candle of a version the lab could not clear: one key per version, so one version never lights twice. */
export function candleOf(outcome: LabOutcome): Candle {
  const name = HARNESS_NAMES.get(outcome.harness) ?? outcome.harness;
  const title = outcome.status === "fail" ? `Collie misreads ${name} ${outcome.version} (harness lab)` : `The harness lab could not finish ${name} ${outcome.version}`;
  const where = outcome.issue === undefined ? `Run log: ${outcome.logPath}` : `Issue draft: ${outcome.issue.json}\nRun log: ${outcome.logPath}`;
  return { key: `drift:${outcome.harness}@${outcome.version}`, title, body: `${outcome.note}\n\n${where}\n` };
}

/**
 * Light a candle with `darius candle light`. Severity medium: it needs the operator soon, and it is not urgent.
 * Lighting a key again at the same severity sends nothing; darius counts the report. Never throws: a missing
 * darius or a failed call returns a line for notify.log, and the run goes on.
 */
export function lightCandle(candle: Candle, run: CommandRunner = realRunner, hasDarius: () => boolean = () => Bun.which("darius") !== null): string | null {
  if (!hasDarius()) return `darius is not on PATH, so no candle was lit for ${candle.key}`;
  const argv = ["darius", "candle", "light", candle.key, "--title", candle.title, "--severity", "medium", "--project", CANDLE_PROJECT, "--source", "harness-lab", "--deliver", "email", "--stdin"];
  try {
    const done = run(argv, candle.body);
    return done.code === 0 ? null : `darius candle light ${candle.key} exited ${String(done.code)}: ${done.out.split("\n").pop() ?? ""}`;
  } catch (err) {
    return `darius candle light ${candle.key} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Lights one candle. Returns the line for notify.log when it could not, else null. Only a real drift failure and a final `failed` row call it. */
export type Light = (candle: Candle) => string | null;

/**
 * Tell the person once per (harness, version, verdict): a real drift failure (`fail`), a final `failed` (a
 * retry that ran out, or a cause that is no environment) and a new pass. A `retry` row tells nobody: the loop
 * tries it again. A `fail` and a `failed` also light a candle (`light`). A pass writes its `notify.log` line only.
 * The ledger row remembers what it told, so a second tick with the same verdict is silent (M44 spec 06).
 */
export function tellOnce(ledgerFile: string, outcome: LabOutcome, notify: Notify, light?: Light): boolean {
  if (outcome.status !== "fail" && outcome.status !== "failed" && outcome.status !== "pass") return false;
  const row = findRow(loadLedger(ledgerFile, Date.now()), outcome.harness, outcome.version);
  if (row === undefined || row.notified === outcome.status) return false;
  notify(notifyLine(outcome));
  if (outcome.status !== "pass" && light !== undefined) {
    const trouble = light(candleOf(outcome));
    if (trouble !== null) notify(`harness lab: ${trouble}`);
  }
  markNotified(ledgerFile, outcome.harness, outcome.version, outcome.status);
  return true;
}

export interface RunReport {
  readonly outcomes: readonly LabOutcome[];
  readonly told: number;
}

/** Run each pending candidate once, in order. Never throws for one pair's end. */
/** The device token in a `--token-file`: the first line, trimmed. Throws when the file is missing or empty. */
export function readTokenFile(path: string, read: (path: string) => string = (file) => readFileSync(file, "utf8")): string {
  let text: string;
  try {
    text = read(path);
  } catch (err) {
    throw new Error(`--token-file ${path} cannot be read: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const token = text.split("\n")[0]?.trim() ?? "";
  if (token.length === 0) throw new Error(`--token-file ${path} holds no token`);
  return token;
}

export async function runCandidates(candidates: readonly Candidate[], cli: CliOptions, ports: LabPorts, notify: Notify, now: () => number = () => Date.now(), light?: Light): Promise<RunReport> {
  const outcomes: LabOutcome[] = [];
  let told = 0;
  // Read once, before any run: a missing token stops the command before anything is spent.
  const bridge = cli.bridge === null ? undefined : { url: cli.bridge.url, token: readTokenFile(cli.bridge.tokenFile) };
  for (const candidate of pending(allowed(candidates, cli.agents), cli.ledger, now(), cli.maxRuns)) {
    const options: LabOptions = {
      harness: candidate.harness,
      version: candidate.version,
      repo: cli.repo,
      labRoot: cli.labRoot,
      ledgerPath: cli.ledger,
      openIssue: cli.openIssue,
      issueRepo: cli.issueRepo ?? undefined,
      publish: cli.publish,
      now,
      legs: cli.legs,
      named: candidate.named,
      bridge,
      pairTimeoutMs: cli.pairTimeoutMs,
      loadLimit: cli.maxLoad > 0 ? cli.maxLoad : undefined,
    };
    const outcome = await runLab(options, ports);
    outcomes.push(outcome);
    // A deferral writes no row, so it would be a silent night. One notify line makes it visible.
    if (outcome.status === "deferred") notify(`harness lab: ${outcome.harness} ${outcome.version} deferred: ${outcome.note}`);
    if (tellOnce(cli.ledger, outcome, notify, light)) told++;
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

/** The reason the repo is refused, or null. Called before a run, so a bad `--repo` stops the command at once. */
export function repoProblem(repo: string): string | null {
  try {
    checkSource(repo);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * The sweep that runs at the start of main.ts and watch.ts, before any plan or run. A night with no new
 * version, or a `--plan`, still removes the run folders and the tmux servers an earlier run left. Returns
 * one line per thing it did. It never throws: a sweep that fails must not stop the lab.
 */
export async function sweepAtStart(cli: CliOptions, now: number = Date.now(), live: Liveness = realLiveness): Promise<string[]> {
  try {
    const done = await sweepLab({ labRoot: cli.labRoot, ledgerPath: cli.ledger, now, live });
    return [
      ...done.removed.map((name) => `sweep: removed the run folder of ${name}`),
      ...done.killed.map((name) => `sweep: killed the tmux server ${name}`),
      ...done.settled.map((name) => `sweep: ${name} was running and its process is dead, so the row is failed`),
    ];
  } catch (err) {
    return [`sweep failed: ${err instanceof Error ? err.message : String(err)}`];
  }
}

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowed, candleOf, CANDLE_PROJECT, fileNotify, LOOP_AGENTS, lightCandle, parseCli, pending, runCandidates, tellOnce, type CliOptions, type CommandRunner } from "./cli";
import { classifyFailure, RETRY_GAP_MS, RETRY_MAX_AGE_MS, RETRY_MAX_TRIES } from "./failure-class";
import { canRetry, claim, expireStale, findRow, loadLedger, readLedger, settleFailure, shouldRun, writeLedger, type LabRow } from "./lab-ledger";
import { guardTick, loadGuardLine, loadTooHigh } from "./load-guard";
import { runLab, type LabOptions, type LabOutcome, type LabPorts, type SessionFacts } from "./run";
import { cleanup, planCleanup } from "./retry-old";
import { LabInfraError } from "./seed";
import type { ScreenFact } from "./verdict";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "drift-loop-"));
  dirs.push(dir);
  return dir;
};

const NOW = Date.parse("2026-11-19T10:00:00Z");
const H = 60 * 60 * 1000;

const argv = (...args: string[]): CliOptions => {
  const parsed = parseCli(args, "/checkout", {}, "/home/u");
  if (parsed === "help") throw new Error("help");
  return parsed;
};

describe("failure classes", () => {
  test("an environment cause has a class", () => {
    expect(classifyFailure("npm install opencode-ai@1.20.0 exited 1: npm error notarget No matching version found for opencode-ai@1.20.0 with a date before 11/12/2026")).toBe("notarget");
    expect(classifyFailure("npm error code ETARGET")).toBe("notarget");
    expect(classifyFailure("402 requires more credits, or fewer max_tokens")).toBe("credits");
    expect(classifyFailure("HTTP 402 from openrouter")).toBe("credits");
    expect(classifyFailure("the Claude access token has 4 minutes left, and the lab needs 20")).toBe("login");
    expect(classifyFailure("OAuth token has expired")).toBe("login");
    expect(classifyFailure("load average 6.2 is above 4.0 after the run")).toBe("load");
    expect(classifyFailure("timed out: the pair took more than 15 minutes")).toBe("timeout");
    expect(classifyFailure("npm install x exited 143: ")).toBe("timeout");
    expect(classifyFailure("interrupted by SIGTERM")).toBe("interrupted");
    expect(classifyFailure("interrupted: the run's process 4242 died")).toBe("interrupted");
  });

  test("a real failure, and a version number that holds 401 or 402, has no class", () => {
    expect(classifyFailure("tmux died")).toBeNull();
    expect(classifyFailure("uncaughtException: boom")).toBeNull();
    expect(classifyFailure("the installed binary prints 2.1.401, and the lab asked for 2.1.402")).toBeNull();
    expect(classifyFailure("")).toBeNull();
  });
});

describe("the retry state in the ledger", () => {
  const start = (ledger: string, now: number, named = false): boolean => claim(ledger, "claude", "2.1.400", "2026-11-19", "/l", now, 1, named);

  test("an environment failure is a retry row with a count, a first and a last try; an unknown one is final", () => {
    const ledger = join(tmp(), "ledger.json");
    start(ledger, NOW);
    const end = settleFailure(ledger, "claude", "2.1.400", "npm error notarget No matching version", NOW);
    expect(end).toMatchObject({ result: "retry", cause: "notarget" });
    expect(findRow(readLedger(ledger), "claude", "2.1.400")).toMatchObject({ result: "retry", tries: 1, firstTry: NOW, lastTry: NOW, cause: "notarget" });

    start(ledger, NOW + 2 * H);
    expect(settleFailure(ledger, "claude", "2.1.400", "tmux died", NOW + 2 * H).result).toBe("failed");
    expect(findRow(readLedger(ledger), "claude", "2.1.400")?.cause).toBeUndefined();
  });

  test("the wait grows per try, so the loop never repeats a try inside one hour", () => {
    const ledger = join(tmp(), "ledger.json");
    start(ledger, NOW);
    settleFailure(ledger, "claude", "2.1.400", "notarget", NOW);
    const at = (ms: number): boolean => shouldRun(readLedger(ledger), "claude", "2.1.400", false, NOW + ms);
    expect(at(10 * 60_000)).toBe(false);
    expect(at(RETRY_GAP_MS)).toBe(true);
    expect(start(ledger, NOW + H)).toBe(true);
    settleFailure(ledger, "claude", "2.1.400", "notarget", NOW + H);
    // Try 2: the wait is two gaps.
    const second = (ms: number): boolean => shouldRun(readLedger(ledger), "claude", "2.1.400", false, NOW + H + ms);
    expect(second(RETRY_GAP_MS)).toBe(false);
    expect(second(2 * RETRY_GAP_MS)).toBe(true);
  });

  test("a retry row that is not due is not claimed: no second paid action inside the wait", () => {
    const ledger = join(tmp(), "ledger.json");
    start(ledger, NOW);
    settleFailure(ledger, "claude", "2.1.400", "notarget", NOW);
    expect(start(ledger, NOW + 60_000)).toBe(false);
    expect(findRow(readLedger(ledger), "claude", "2.1.400")?.result).toBe("retry");
    // A named run takes it at once.
    expect(start(ledger, NOW + 60_000, true)).toBe(true);
  });

  test("the fifth environment failure is final, with a note that says so", () => {
    const ledger = join(tmp(), "ledger.json");
    let at = NOW;
    for (let n = 1; n <= RETRY_MAX_TRIES; n++) {
      expect(start(ledger, at)).toBe(true);
      const end = settleFailure(ledger, "claude", "2.1.400", "load average 7 is above 4", at);
      expect(end.result).toBe(n < RETRY_MAX_TRIES ? "retry" : "failed");
      at += 10 * H;
    }
    const row = findRow(readLedger(ledger), "claude", "2.1.400");
    expect(row).toMatchObject({ result: "failed", tries: RETRY_MAX_TRIES });
    expect(row?.note).toContain("gave up after 5 tries (load)");
    expect(shouldRun(readLedger(ledger), "claude", "2.1.400", false, at + 100 * H)).toBe(false);
  });

  test("a retry row older than seven days turns final on the next read", () => {
    const ledger = join(tmp(), "ledger.json");
    start(ledger, NOW);
    settleFailure(ledger, "claude", "2.1.400", "notarget", NOW);
    expect(loadLedger(ledger, NOW + 6 * 24 * H).rows[0]?.result).toBe("retry");
    const late = loadLedger(ledger, NOW + RETRY_MAX_AGE_MS + H);
    expect(late.rows[0]?.result).toBe("failed");
    expect(late.rows[0]?.note).toContain("gave up after 1 tries (notarget)");
    expect(readLedger(ledger).rows[0]?.result).toBe("failed");
  });

  test("the retry count survives the next claim, and canRetry says when one more failure would be the last", () => {
    const ledger = join(tmp(), "ledger.json");
    start(ledger, NOW);
    settleFailure(ledger, "claude", "2.1.400", "notarget", NOW);
    start(ledger, NOW + H);
    expect(findRow(readLedger(ledger), "claude", "2.1.400")).toMatchObject({ result: "running", tries: 1, firstTry: NOW });
    expect(canRetry(ledger, "claude", "2.1.400", NOW + H)).toBe(true);
    const rows: LabRow[] = [{ harness: "claude", version: "2.1.400", date: "2026-11-19", result: "running", log: "/l", tries: RETRY_MAX_TRIES - 1, firstTry: NOW, lastTry: NOW }];
    writeLedger(ledger, { rows });
    expect(canRetry(ledger, "claude", "2.1.400", NOW + H)).toBe(false);
  });

  test("pass, fail and an unnamed failed row stay final; expireStale leaves a fresh retry alone", () => {
    const row = (result: LabRow["result"]) => ({ rows: [{ harness: "pi", version: "1.4.0", date: "2026-11-19", result, log: "/l" } satisfies LabRow] });
    for (const result of ["pass", "fail", "failed", "walk-only", "running"] as const) expect(shouldRun(row(result), "pi", "1.4.0", false, NOW)).toBe(false);
    const fresh = { rows: [{ harness: "pi", version: "1.4.0", date: "2026-11-19", result: "retry" as const, log: "/l", tries: 1, firstTry: NOW, lastTry: NOW }] };
    expect(expireStale(fresh, NOW + H).moved).toBe(0);
  });
});

describe("the agent allowlist", () => {
  test("--loop plans claude and opencode only, two runs a tick, with the guard and a limit per pair", () => {
    const cli = argv("--loop");
    expect(cli.agents).toEqual([...LOOP_AGENTS]);
    expect(cli.agents).toEqual(["claude", "opencode"]);
    expect(cli.harnesses).toEqual(["claude", "opencode"]);
    expect(cli.maxRuns).toBe(2);
    expect(cli.maxLoad).toBe(4);
    expect(cli.pairTimeoutMs).toBe(15 * 60_000);
    expect(cli.loop).toBe(true);
  });

  test("a hand run keeps every harness, with no guard and no limit", () => {
    const cli = argv();
    expect(cli.agents).toBeNull();
    expect(cli.harnesses).toContain("codex");
    expect(cli.maxRuns).toBe(4);
    expect(cli.maxLoad).toBe(0);
    expect(cli.pairTimeoutMs).toBeUndefined();
  });

  test("--agents narrows the feeds; a harness or a pair outside it is refused", () => {
    expect(argv("--agents", "claude").harnesses).toEqual(["claude"]);
    expect(() => argv("--agents", "claude", "--harness", "codex")).toThrow(/outside --agents/);
    expect(() => argv("--agents", "claude", "--version", "codex=0.170.0")).toThrow(/outside --agents/);
    expect(() => argv("--agents", "nope")).toThrow(/unknown harness/);
  });

  test("the loop never takes a paid agent, by flag or by name", () => {
    expect(() => argv("--loop", "--agents", "claude,omp")).toThrow(/free agents only/);
    expect(() => argv("--loop", "--agents", "codex")).toThrow(/free agents only/);
    expect(() => argv("--loop", "--version", "omp=18.20.0")).toThrow(/outside --agents/);
    expect(() => argv("--loop", "--harness", "codex")).toThrow(/outside --agents/);
    expect(() => argv("--loop", "--leg", "phone", "--version", "claude=2.1.400")).toThrow(/does not take/);
    expect(argv("--loop", "--max-runs", "1", "--max-load", "2").maxRuns).toBe(1);
  });

  test("candidates outside the list are dropped before the ledger is read", () => {
    const list = [
      { harness: "claude", version: "2.1.400", source: "t" },
      { harness: "codex", version: "0.170.0", source: "t" },
      { harness: "omp", version: "18.20.0", source: "t" },
    ];
    expect(allowed(list, ["claude", "opencode"]).map((c) => c.harness)).toEqual(["claude"]);
    expect(allowed(list, null)).toHaveLength(3);
    const ledger = join(tmp(), "ledger.json");
    expect(pending(allowed(list, ["claude", "opencode"]), ledger, NOW, 2).map((c) => c.harness)).toEqual(["claude"]);
  });

  test("runCandidates spends nothing on a paid agent the loop does not name", async () => {
    const root = tmp();
    const cli = { ...argv("--loop"), labRoot: root, ledger: join(root, "state", "ledger.json") };
    const seen: string[] = [];
    const ports = fakePorts({
      async install() {
        seen.push("install");
        throw new LabInfraError("stop here");
      },
    });
    const done = await runCandidates([{ harness: "codex", version: "0.170.0", source: "t" }, { harness: "omp", version: "18.20.0", source: "t" }], cli, ports, () => {}, () => NOW);
    expect(done.outcomes).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe("the load guard", () => {
  test("above the limit the tick logs one line and does nothing", () => {
    const lines: string[] = [];
    expect(guardTick(4, 4.01, NOW, (line) => lines.push(line))).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("load average 4.01 is above 4.0");
    expect(lines[0]).toContain("marked nothing");
    expect(lines[0]).toBe(loadGuardLine(4.01, 4, NOW));
  });

  test("at or under the limit, and with the guard off, the tick runs", () => {
    const lines: string[] = [];
    expect(guardTick(4, 4, NOW, (line) => lines.push(line))).toBe(false);
    expect(guardTick(4, 0.3, NOW, (line) => lines.push(line))).toBe(false);
    expect(guardTick(0, 40, NOW, (line) => lines.push(line))).toBe(false);
    expect(loadTooHigh(40, 0)).toBe(false);
    expect(lines).toEqual([]);
  });
});

/** A session whose screens read free, a walk that ends clean. */
const idle: ScreenFact = { leg: "start", label: "start", expects: "idle", surface: { turn: "idle", composer: "empty", modal: "none" }, free: true, cue: "none", rows: [] };
const dialog: ScreenFact = { leg: "walk", label: "/model", expects: "dialog", surface: { turn: "unknown", composer: "unknown", modal: "ask" }, free: false, cue: "strong", rows: ["Select model"] };
const goodWalk = { reached: true, returned: true, menuRead: true, startedTurn: null, sent: ["/model"], unclassified: [], missing: [] };
const goodSession: SessionFacts = {
  facts: { profile: "provisional", walk: goodWalk, screens: [idle, dialog], send: { outcome: "sent", probed: true, keys: 2 }, ask: { outcome: "sent", fileCreated: false }, turns: 2 },
  counters: [],
};
/** The same run with a walk that never came back: a drift verdict. */
const driftSession: SessionFacts = { ...goodSession, facts: { ...goodSession.facts, walk: { ...goodWalk, returned: false } } };

function fakePorts(over: Partial<LabPorts> = {}): LabPorts {
  return {
    liveness: { isAlive: () => false, servers: () => [], killServer: async () => {} },
    async stopAll() {},
    clone: (source) => `${source}-clone`,
    async preflight() {},
    async install(_spec, runDirs, version) {
      mkdirSync(runDirs.config, { recursive: true });
      return version;
    },
    async session() {
      return goodSession;
    },
    publishPass: () => ({ branch: "harness-lab/x", worktree: "/w", commit: "abc1234", files: [] }),
    openIssue: () => "https://example.test/1",
    ...over,
  };
}

function rig() {
  const labRoot = tmp();
  const ledger = join(labRoot, "state", "ledger.json");
  const options = { harness: "claude", version: "2.1.400", repo: "/repo", labRoot, ledgerPath: ledger, openIssue: false, now: () => NOW, signals: { install: () => () => {} }, redaction: { home: "/home/alice", user: "alice", host: "bluefin", labDirs: [labRoot] } } satisfies LabOptions;
  return { options, ledger, labRoot };
}

describe("a run that ends on the environment", () => {
  test("a registry that does not list the version yet is a retry, not a final failed row", async () => {
    const { options, ledger } = rig();
    const done = await runLab(options, fakePorts({ install: async () => { throw new LabInfraError("npm install claude@2.1.400 exited 1: npm error notarget No matching version found"); } }));
    expect(done.status).toBe("retry");
    expect(done.note).toContain("environment: notarget, try 1 of 5");
    expect(findRow(readLedger(ledger), "claude", "2.1.400")).toMatchObject({ result: "retry", tries: 1, cause: "notarget" });
    // The next tick, inside the wait: nothing is spent.
    const calls: string[] = [];
    const again = await runLab(options, fakePorts({ install: async () => { calls.push("install"); return "x"; } }));
    expect(again.status).toBe("skipped");
    expect(calls).toEqual([]);
  });

  test("after the wait the pair runs again, and a pass settles the row for good", async () => {
    const { options, ledger } = rig();
    await runLab(options, fakePorts({ install: async () => { throw new LabInfraError("npm error notarget"); } }));
    const later = { ...options, now: () => NOW + 2 * H };
    const done = await runLab({ ...later, publish: false }, fakePorts());
    expect(done.status).toBe("pass");
    expect(findRow(readLedger(ledger), "claude", "2.1.400")?.result).toBe("pass");
    expect((await runLab({ ...later, now: () => NOW + 9 * H }, fakePorts())).status).toBe("skipped");
  });

  test("a cause that is no environment stays final failed, as before", async () => {
    const { options, ledger } = rig();
    const done = await runLab(options, fakePorts({ session: async () => { throw new Error("tmux died"); } }));
    expect(done.status).toBe("failed");
    expect(findRow(readLedger(ledger), "claude", "2.1.400")?.result).toBe("failed");
  });

  test("a pair that runs past its limit is stopped, its folder and tmux are gone, and the row is a retry", async () => {
    const { options, ledger, labRoot } = rig();
    const calls: string[] = [];
    const done = await runLab({ ...options, pairTimeoutMs: 30 }, fakePorts({
      async stopAll() { calls.push("stop-all"); },
      session: () => new Promise<SessionFacts>(() => {}),
    }));
    expect(done.status).toBe("retry");
    expect(done.note).toContain("timed out");
    expect(calls).toContain("stop-all");
    expect(findRow(readLedger(ledger), "claude", "2.1.400")).toMatchObject({ result: "retry", cause: "timeout" });
    expect(existsSync(join(labRoot, "claude-2.1.400"))).toBe(false);
  });
});

describe("a drift verdict", () => {
  const busy = (load: number) => fakePorts({ session: async () => driftSession, loadAverage: () => load });

  test("a real drift failure is final and writes the issue draft", async () => {
    const { options, ledger } = rig();
    const done = await runLab({ ...options, loadLimit: 4 }, busy(0.5));
    expect(done.status).toBe("fail");
    expect(done.issue).toBeDefined();
    expect(findRow(readLedger(ledger), "claude", "2.1.400")?.result).toBe("fail");
  });

  test("the same verdict on a busy machine is a retry with no issue draft", async () => {
    const { options, ledger } = rig();
    const done = await runLab({ ...options, loadLimit: 4 }, busy(7.5));
    expect(done.status).toBe("retry");
    expect(done.issue).toBeUndefined();
    expect(findRow(readLedger(ledger), "claude", "2.1.400")).toMatchObject({ result: "retry", cause: "load" });
  });

  test("without a load limit, a busy machine changes nothing", async () => {
    const { options } = rig();
    expect((await runLab(options, busy(7.5))).status).toBe("fail");
  });

  test("on the last try a busy machine no longer hides the verdict", async () => {
    const { options, ledger } = rig();
    writeLedger(ledger, { rows: [] });
    claim(ledger, "claude", "2.1.400", "2026-11-19", "/l", NOW - 50 * H, 1);
    settleFailure(ledger, "claude", "2.1.400", "load average 9", NOW - 50 * H);
    const rows = readLedger(ledger).rows.map((row) => Object.assign({}, row, { tries: RETRY_MAX_TRIES - 1 }));
    writeLedger(ledger, { rows });
    const done = await runLab({ ...options, loadLimit: 4 }, busy(7.5));
    expect(done.status).toBe("fail");
    expect(done.issue).toBeDefined();
  });
});

describe("notices", () => {
  const outcome = (status: LabOutcome["status"]): LabOutcome => ({ harness: "claude", version: "2.1.400", status, note: "n", logPath: "/l" });

  test("a pass and a real drift failure tell once; a retry tells nobody", () => {
    const root = tmp();
    const ledger = join(root, "ledger.json");
    const told: string[] = [];
    claim(ledger, "claude", "2.1.400", "2026-11-19", "/l", Date.now(), 1);
    settleFailure(ledger, "claude", "2.1.400", "notarget", Date.now());
    expect(tellOnce(ledger, outcome("retry"), (line) => told.push(line))).toBe(false);
    claim(ledger, "claude", "2.1.400", "2026-11-19", "/l", Date.now() + 2 * H, 1, true);
    writeLedger(ledger, { rows: readLedger(ledger).rows.map((row) => Object.assign({}, row, { result: "pass" as const })) });
    expect(tellOnce(ledger, outcome("pass"), (line) => told.push(line))).toBe(true);
    expect(tellOnce(ledger, outcome("pass"), (line) => told.push(line))).toBe(false);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("claude 2.1.400 pass");
  });

  test("a notice goes to notify.log, and nothing else is written", () => {
    const root = tmp();
    const notify = fileNotify(root, { now: () => NOW });
    notify("harness lab: claude 2.1.400 fail: drift");
    expect(readFileSync(join(root, "notify.log"), "utf8")).toBe(`${new Date(NOW).toISOString()} harness lab: claude 2.1.400 fail: drift\n`);
    expect(existsSync(join(root, "push-queue.jsonl"))).toBe(false);
  });

  test("the same line twice inside twelve hours is written once", () => {
    const root = tmp();
    let at = NOW;
    const notify = fileNotify(root, { now: () => at });
    notify("harness lab: claude 2.1.400 deferred: the login has 4 minutes left");
    at += H;
    notify("harness lab: claude 2.1.400 deferred: the login has 4 minutes left");
    expect(readFileSync(join(root, "notify.log"), "utf8").trim().split("\n")).toHaveLength(1);
    at += 13 * H;
    notify("harness lab: claude 2.1.400 deferred: the login has 4 minutes left");
    expect(readFileSync(join(root, "notify.log"), "utf8").trim().split("\n")).toHaveLength(2);
  });
});

describe("the darius candle", () => {
  const drift: LabOutcome = { harness: "claude", version: "2.1.329", status: "fail", note: "the walk never came back", logPath: "/l/claude-2.1.329.log", issue: { json: "/i/claude-2.1.329.json", markdown: "/i/claude-2.1.329.md" } };
  interface Call {
    readonly argv: readonly string[];
    readonly stdin: string;
  }
  const stub = (code = 0, out = "") => {
    const calls: Call[] = [];
    const run: CommandRunner = (command, stdin) => {
      calls.push({ argv: command, stdin });
      return { code, out };
    };
    return { calls, run };
  };

  test("the command line: one key per version, severity medium, the workspace project named, the paths in the body", () => {
    const { run, calls } = stub();
    expect(lightCandle(candleOf(drift), run, () => true)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toEqual(["darius", "candle", "light", "drift:claude@2.1.329", "--title", "Collie misreads Claude Code 2.1.329 (harness lab)", "--severity", "medium", "--project", CANDLE_PROJECT, "--source", "harness-lab", "--deliver", "email", "--stdin"]);
    expect(CANDLE_PROJECT).toBe("collie-workspace");
    expect(calls[0]?.stdin).toContain("Issue draft: /i/claude-2.1.329.json");
    expect(calls[0]?.stdin).toContain("Run log: /l/claude-2.1.329.log");
  });

  test("a drift failure and a final failed light a candle; a pass and a retry light none", () => {
    const root = tmp();
    const ledger = join(root, "ledger.json");
    const { run, calls } = stub();
    const light = (candle: Parameters<typeof lightCandle>[0]): string | null => lightCandle(candle, run, () => true);
    const row = (version: string, result: LabRow["result"]): void => {
      claim(ledger, "claude", version, "2026-11-19", "/l", Date.now(), 1);
      writeLedger(ledger, { rows: [...readLedger(ledger).rows.filter((r) => r.version !== version), { harness: "claude", version, date: "2026-11-19", result, log: "/l" }] });
    };
    row("2.1.329", "fail");
    row("2.1.330", "failed");
    row("2.1.331", "pass");
    row("2.1.332", "retry");
    const end = (version: string, status: LabOutcome["status"]): LabOutcome => ({ ...drift, version, status, issue: undefined });
    tellOnce(ledger, end("2.1.329", "fail"), () => {}, light);
    tellOnce(ledger, end("2.1.330", "failed"), () => {}, light);
    tellOnce(ledger, end("2.1.331", "pass"), () => {}, light);
    tellOnce(ledger, end("2.1.332", "retry"), () => {}, light);
    expect(calls.map((c) => c.argv[3])).toEqual(["drift:claude@2.1.329", "drift:claude@2.1.330"]);
    expect(calls[1]?.argv[5]).toBe("The harness lab could not finish Claude Code 2.1.330");
    // Told once: the same verdict on the next tick lights nothing.
    tellOnce(ledger, end("2.1.329", "fail"), () => {}, light);
    expect(calls).toHaveLength(2);
  });

  test("no darius, a failing call and a throwing runner write a notify line and never throw", () => {
    expect(lightCandle(candleOf(drift), stub().run, () => false)).toContain("not on PATH");
    expect(lightCandle(candleOf(drift), stub(1, "darius: no project 'x'").run, () => true)).toContain("exited 1: darius: no project 'x'");
    expect(lightCandle(candleOf(drift), () => {
      throw new Error("spawn failed");
    }, () => true)).toContain("spawn failed");

    const root = tmp();
    const ledger = join(root, "ledger.json");
    claim(ledger, "claude", "2.1.329", "2026-11-19", "/l", Date.now(), 1);
    writeLedger(ledger, { rows: [{ harness: "claude", version: "2.1.329", date: "2026-11-19", result: "fail", log: "/l" }] });
    const told: string[] = [];
    expect(tellOnce(ledger, drift, (line) => told.push(line), (candle) => lightCandle(candle, stub(1, "boom").run, () => true))).toBe(true);
    expect(told).toHaveLength(2);
    expect(told[1]).toContain("exited 1: boom");
  });
});

describe("the one-shot cleanup of the notarget rows", () => {
  const OLD: LabRow[] = [
    { harness: "claude", version: "2.1.309", date: "2026-10-23", result: "failed", log: "/l", note: "npm install @anthropic-ai/claude-code@2.1.309 exited 1: npm error notarget No matching version found", notified: "failed" },
    { harness: "pi", version: "1.4.0", date: "2026-10-23", result: "failed", log: "/l", note: "tmux died" },
    { harness: "claude", version: "2.1.302", date: "2026-10-17", result: "pass", log: "/l" },
    { harness: "opencode", version: "1.19.4", date: "2026-10-22", result: "failed", log: "/l", note: "npm error notarget" },
  ];

  test("only a failed notarget row of that day moves, and it is due at once", () => {
    const { changes, next } = planCleanup({ rows: OLD }, "2026-10-23", NOW);
    expect(changes.map((c) => c.before.version)).toEqual(["2.1.309"]);
    expect(next.rows.map((row) => row.result)).toEqual(["retry", "failed", "pass", "failed"]);
    expect(shouldRun(next, "claude", "2.1.309", false, NOW)).toBe(true);
    expect(next.rows[0]).toMatchObject({ tries: 0, firstTry: NOW, cause: "notarget" });
  });

  test("the default is a dry run: it prints the change and writes nothing", () => {
    const root = tmp();
    const ledger = join(root, "ledger.json");
    writeLedger(ledger, { rows: OLD });
    const before = readFileSync(ledger, "utf8");
    const lines = cleanup({ ledger, day: "2026-10-23", apply: false, now: NOW });
    expect(lines[0]).toBe("claude 2.1.309 (2026-10-23): failed -> retry (notarget)");
    expect(lines.at(-1)).toContain("dry run: 1 row(s) would change");
    expect(readFileSync(ledger, "utf8")).toBe(before);
  });

  test("--apply writes the rows and keeps a copy of the old ledger", () => {
    const root = tmp();
    const ledger = join(root, "ledger.json");
    writeLedger(ledger, { rows: OLD });
    const before = readFileSync(ledger, "utf8");
    const lines = cleanup({ ledger, day: "2026-10-23", apply: true, now: NOW });
    expect(lines.at(-1)).toContain("changed 1 row(s)");
    expect(findRow(readLedger(ledger), "claude", "2.1.309")?.result).toBe("retry");
    expect(readFileSync(join(root, "ledger.json.bak-2026-11-19"), "utf8")).toBe(before);
    expect(cleanup({ ledger, day: "2026-10-23", apply: true, now: NOW })[0]).toContain("nothing to change");
  });

  test("an unreadable ledger stops the command: no row is invented", () => {
    const root = tmp();
    const ledger = join(root, "ledger.json");
    writeFileSync(ledger, "not json");
    expect(() => cleanup({ ledger, day: "2026-10-23", apply: false, now: NOW })).toThrow();
  });
});

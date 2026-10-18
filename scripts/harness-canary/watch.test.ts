import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { exitCodeOf, parseCli, pending, runCandidates, sweepAtStart, type Candidate, type CliOptions } from "./lab/cli";
import { claim, findRow, readLedger, settle } from "./lab/lab-ledger";
import type { LabPorts, SessionFacts } from "./lab/run";
import { LabDeferred, LabInfraError } from "./lab/seed";
import type { ScreenFact } from "./lab/verdict";
import { newerThanLedger } from "./watch";

// M44 spec 06, carried by M56 spec 10: the lab runs when an installed agent is newer than the ledger,
// tells the operator once per version and verdict, and never runs a pair twice.

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});
const NOW = Date.parse("2026-10-16T03:00:00Z");

interface Rig {
  readonly cli: CliOptions;
  readonly told: string[];
  readonly notify: (line: string) => void;
}

function setup(patch: Partial<CliOptions> = {}): Rig {
  const root = mkdtempSync(join(tmpdir(), "lab-watch-"));
  dirs.push(root);
  const told: string[] = [];
  const cli: CliOptions = { harnesses: ["claude"], pairs: [], repo: "/repo", labRoot: root, ledger: join(root, "state", "ledger.json"), openIssue: false, issueRepo: null, publish: true, plan: false, maxRuns: 4, fakeVersions: [], legs: "all", bridge: null, ...patch };
  return { cli, told, notify: (line) => told.push(line) };
}

const idle: ScreenFact = { leg: "start", label: "start", expects: "idle", surface: { turn: "idle", composer: "empty", modal: "none" }, free: true, cue: "none", rows: [] };
const dialog = (free: boolean): ScreenFact => ({ leg: "walk", label: "/model", expects: "dialog", surface: { turn: "unknown", composer: "unknown", modal: "ask" }, free, cue: "strong", rows: ["Select model"] });
const facts = (free: boolean): SessionFacts => ({
  facts: { profile: "provisional", walk: { reached: true, returned: true, menuRead: true, startedTurn: null, sent: [], unclassified: [], missing: [] }, screens: [idle, dialog(free)], send: { outcome: "sent", probed: true, keys: 1 }, ask: { outcome: "sent", fileCreated: false }, turns: 1 },
  counters: [],
});

function ports(session: () => Promise<SessionFacts>, install?: LabPorts["install"], seen: string[] = []): LabPorts {
  return {
    liveness: { isAlive: () => false, servers: () => [], killServer: async () => {} },
    async stopAll() {},
    clone: (source) => source,
    async preflight() {},
    install:
      install ??
      (async (_spec, _dirs, version) => {
        seen.push("install");
        return version;
      }),
    async session() {
      seen.push("session");
      return session();
    },
    publishPass() {
      seen.push("publish");
      return { branch: "harness-lab/claude-2.1.301", worktree: "/w", commit: "abc1234", files: [] };
    },
    openIssue() {
      seen.push("open-issue");
      return "u";
    },
  };
}

const CAND: Candidate[] = [{ harness: "claude", version: "2.1.301", source: "test" }];

describe("the version-change trigger", () => {
  test("it picks the agents that are newer than the ledger, and the fake version stands in for the binary", () => {
    const { cli } = setup({ fakeVersions: [{ harness: "claude", version: "99.0.0" }] });
    const found = newerThanLedger(cli, () => null);
    expect(found.map((candidate) => `${candidate.harness} ${candidate.version}`)).toEqual(["claude 99.0.0"]);
    expect(found[0]?.source).toContain("99.0.0");
  });

  test("an agent that is the same, older or not installed is not picked", () => {
    const { cli } = setup();
    expect(newerThanLedger(cli, () => "0.0.1")).toEqual([]);
    expect(newerThanLedger(cli, () => null)).toEqual([]);
  });
});

describe("watch: no repeat", () => {
  test("repeat: the same version and verdict tell the operator once, over two nights", async () => {
    const { cli, told, notify } = setup();
    const seen: string[] = [];
    const bad = ports(async () => facts(true), undefined, seen);
    const night1 = await runCandidates(CAND, cli, bad, notify, () => NOW);
    const night2 = await runCandidates(CAND, cli, bad, notify, () => NOW + 86_400_000);
    expect(night1.outcomes[0]?.status).toBe("fail");
    expect(night1.told).toBe(1);
    expect(night2.outcomes).toEqual([]);
    expect(night2.told).toBe(0);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("claude 2.1.301 fail");
    // The session ran once: a second night spent nothing.
    expect(seen.filter((step) => step === "session")).toHaveLength(1);
  });

  test("repeat: the ledger remembers what was told, so a restart of the process stays silent", async () => {
    const { cli, told, notify } = setup();
    await runCandidates(CAND, cli, ports(async () => facts(true)), notify, () => NOW);
    expect(findRow(readLedger(cli.ledger), "claude", "2.1.301")?.notified).toBe("fail");
    expect(pending(CAND, cli.ledger, NOW, 4)).toEqual([]);
    expect(told).toHaveLength(1);
  });

  test("repeat: a pair that is in the ledger in any result is not in the pending list", () => {
    const { cli } = setup();
    claim(cli.ledger, "claude", "2.1.301", "2026-10-16", "/l", NOW);
    settle(cli.ledger, "claude", "2.1.301", { result: "pass" });
    expect(pending(CAND, cli.ledger, NOW, 4)).toEqual([]);
    expect(pending([...CAND, { harness: "claude", version: "2.1.302", source: "x" }, { harness: "claude", version: "2.1.302", source: "x" }], cli.ledger, NOW, 4).map((c) => c.version)).toEqual(["2.1.302"]);
  });

  test("repeat: at most max-runs pairs run in one invocation", () => {
    const { cli } = setup();
    const many = ["1.0.1", "1.0.2", "1.0.3"].map((version) => ({ harness: "claude", version, source: "x" }));
    expect(pending(many, cli.ledger, NOW, 2)).toHaveLength(2);
  });
});

describe("watch: retry", () => {
  test("retry: an install that fails once is tried once more, and a second failure writes a failed row", async () => {
    const { cli, told, notify } = setup();
    let tries = 0;
    const broken = ports(
      async () => facts(false),
      async () => {
        tries++;
        throw new LabInfraError("npm exited 1");
      },
    );
    const done = await runCandidates(CAND, cli, broken, notify, () => NOW);
    expect(tries).toBe(2);
    expect(done.outcomes[0]?.status).toBe("failed");
    expect(told[0]).toContain("failed");
    expect(exitCodeOf(done.outcomes)).toBe(1);
  });

  test("retry: a run that already spent a model turn is never run again, so a fail is not retried", async () => {
    const { cli, notify } = setup();
    const seen: string[] = [];
    await runCandidates(CAND, cli, ports(async () => facts(true), undefined, seen), notify, () => NOW);
    expect(seen.filter((step) => step === "session")).toHaveLength(1);
  });

  test("retry: a fail saves the screens as an issue file and the notice names its path", async () => {
    const { cli, told, notify } = setup();
    const done = await runCandidates(CAND, cli, ports(async () => facts(true)), notify, () => NOW);
    const file = done.outcomes[0]?.issue?.json ?? "";
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("Select model");
    expect(told[0]).toContain(file);
  });
});

describe("watch: pass", () => {
  test("pass: a pass makes the branch commit, tells nobody and exits 0", async () => {
    const { cli, told, notify } = setup();
    const seen: string[] = [];
    const done = await runCandidates(CAND, cli, ports(async () => facts(false), undefined, seen), notify, () => NOW);
    expect(done.outcomes[0]?.status).toBe("pass");
    expect(seen).toContain("publish");
    expect(seen).not.toContain("open-issue");
    expect(told).toEqual([]);
    expect(exitCodeOf(done.outcomes)).toBe(0);
  });

  test("pass: the timer never opens an issue unless asked", async () => {
    const { cli, notify } = setup();
    const seen: string[] = [];
    await runCandidates(CAND, cli, ports(async () => facts(true), undefined, seen), notify, () => NOW);
    expect(seen).not.toContain("open-issue");
    const asked = setup({ openIssue: true, issueRepo: "AltanS/collie" });
    const seen2: string[] = [];
    await runCandidates(CAND, asked.cli, ports(async () => facts(true), undefined, seen2), asked.notify, () => NOW);
    expect(seen2).toContain("open-issue");
  });
});

describe("the lab command line", () => {
  const argv = (...args: string[]): CliOptions => {
    const parsed = parseCli(args, "/checkout", {}, "/home/u");
    if (parsed === "help") throw new Error("help");
    return parsed;
  };

  test("the defaults: this checkout, the state ledger, no issue opened", () => {
    const cli = argv();
    expect(cli.repo).toBe("/checkout");
    expect(cli.ledger).toBe(join("/home/u", ".local", "state", "collie-harness-lab", "ledger.json"));
    expect(cli.labRoot).toBe(resolve(join("/home/u", ".cache", "collie-lab", "harness-lab")));
    expect(cli.openIssue).toBe(false);
  });

  test("--open-issue is the only way to open an issue, and the environment names the ledger", () => {
    expect(argv("--open-issue").openIssue).toBe(true);
    expect(parseCli([], "/c", { COLLIE_HARNESS_LAB_LEDGER: "/x/l.json" }, "/home/u")).toMatchObject({ ledger: "/x/l.json" });
  });

  test("--version names pairs, and a bad pair or harness is refused", () => {
    expect(argv("--version", "claude=2.1.301").pairs).toEqual([{ harness: "claude", version: "2.1.301" }]);
    expect(() => argv("--version", "claude=latest")).toThrow(/x\.y\.z/);
    expect(() => argv("--version", "nope=1.0.0")).toThrow(/unknown harness/);
    expect(() => argv("--bogus")).toThrow(/unknown option/);
  });

  test("a deferral is not a silent night: one notify line, no ledger row", async () => {
    const { cli, told, notify } = setup();
    const deferred: LabPorts = {
      ...ports(async () => facts(false)),
      async preflight() {
        throw new LabDeferred("the Claude access token has 16 minutes left");
      },
    };
    const done = await runCandidates(CAND, cli, deferred, notify, () => NOW);
    expect(done.outcomes[0]?.status).toBe("deferred");
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("deferred: the Claude access token has 16 minutes left");
    expect(existsSync(cli.ledger)).toBe(false);
  });

  test("--fake-version needs --dry-run, and --no-publish is read", () => {
    expect(() => parseCli(["--fake-version", "claude=99.0.0"], "/c", {}, "/home/u")).toThrow(/needs --dry-run/);
    const ok = parseCli(["--fake-version", "claude=99.0.0", "--dry-run", "--no-publish"], "/c", {}, "/home/u");
    expect(ok).toMatchObject({ plan: true, publish: false });
  });

  test("the start sweep removes a stale run folder and kills a dead server, with no run and in a plan", async () => {
    for (const plan of [false, true]) {
      const { cli } = setup({ plan });
      const old = join(cli.labRoot, "claude-2.1.299");
      mkdirSync(join(old, "config"), { recursive: true });
      writeFileSync(join(old, "config", ".credentials.json"), "{}");
      const aged = new Date(NOW - 10 * 60_000);
      utimesSync(old, aged, aged);
      const killed: string[] = [];
      const live = { isAlive: (pid: number) => pid === 1, servers: () => ["harness-lab-1", "harness-lab-9999"], killServer: async (name: string) => void killed.push(name) };
      const lines = await sweepAtStart(cli, NOW, live);
      expect(existsSync(old)).toBe(false);
      expect(killed).toEqual(["harness-lab-9999"]);
      expect(lines).toEqual(["sweep: removed the run folder of claude-2.1.299", "sweep: killed the tmux server harness-lab-9999"]);
    }
  });

  test("a sweep that throws gives one line and does not stop the lab", async () => {
    const { cli } = setup();
    const live = { isAlive: () => false, servers: () => { throw new Error("no /tmp"); }, killServer: async () => {} };
    expect(await sweepAtStart(cli, NOW, live)).toEqual(["sweep failed: no /tmp"]);
  });
});

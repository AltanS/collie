import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim, findRow, readLedger, settle, shouldRun } from "./lab-ledger";
import type { PassInput } from "./publish";
import { failCase, passCase } from "../verdict";
import { phoneResult } from "./phone-verdict";
import { runLab, runRoot, type LabOptions, type LabPorts, type SessionFacts, type SessionPlan, type SignalSource } from "./run";
import type { Liveness } from "./sweep";
import { LabDeferred, LabInfraError } from "./seed";
import type { ScreenFact } from "./verdict";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const NOW = Date.parse("2026-10-16T03:00:00Z");

/** A signal source a test fires by hand. No test kills a process. */
class FakeSignals implements SignalSource {
  handler: ((reason: string) => Promise<void>) | null = null;
  installs = 0;
  removes = 0;
  install(handler: (reason: string) => Promise<void>): () => void {
    this.handler = handler;
    this.installs++;
    return () => {
      this.removes++;
      this.handler = null;
    };
  }
  fire(reason: string): Promise<void> {
    if (this.handler === null) throw new Error("no handler installed");
    return this.handler(reason);
  }
}

/** Every folder and file under a root, so a test can look for a leftover without `find`. */
function walkNames(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      out.push(join(dir, entry.name));
      if (entry.isDirectory()) visit(join(dir, entry.name));
    }
  };
  if (existsSync(root)) visit(root);
  return out;
}

const noLive: Liveness = { isAlive: () => false, servers: () => [], killServer: async () => {} };

interface Rig {
  readonly options: LabOptions;
  readonly labRoot: string;
  readonly ledger: string;
}

function setup(): Rig {
  const labRoot = mkdtempSync(join(tmpdir(), "lab-run-"));
  dirs.push(labRoot);
  const ledger = join(labRoot, "state", "ledger.json");
  return { labRoot, ledger, options: { harness: "claude", version: "2.1.301", repo: "/repo", labRoot, ledgerPath: ledger, openIssue: false, now: () => NOW, signals: new FakeSignals(), redaction: { home: "/home/alice", user: "alice", host: "bluefin", labDirs: [labRoot] } } };
}

const idle: ScreenFact = { leg: "start", label: "start", expects: "idle", surface: { turn: "idle", composer: "empty", modal: "none" }, free: true, cue: "none", rows: [] };
const dialog = (free: boolean): ScreenFact => ({ leg: "walk", label: "/model", expects: "dialog", surface: { turn: "unknown", composer: "unknown", modal: "ask" }, free, cue: "strong", rows: ["Select model", "  /home/alice/secret"] });
const goodWalk = { reached: true, returned: true, menuRead: true, startedTurn: null, sent: ["/model"], unclassified: [], missing: [] };

const session = (free: boolean, send = "sent"): SessionFacts => ({
  facts: { profile: "provisional", walk: goodWalk, screens: [idle, dialog(free)], send: { outcome: send, probed: true, keys: 2 }, ask: { outcome: "sent", fileCreated: false }, turns: 2 },
  counters: ["key presses by the lab: 9"],
});

interface Spy {
  readonly calls: string[];
  readonly passes: PassInput[];
  readonly opened: string[];
  readonly ports: LabPorts;
}

function fakes(over: Partial<LabPorts> = {}): Spy {
  const calls: string[] = [];
  const passes: PassInput[] = [];
  const opened: string[] = [];
  const ports: LabPorts = {
    liveness: noLive,
    async stopAll() {
      calls.push("stop-all");
    },
    clone(source) {
      calls.push("clone");
      return `${source}-clone`;
    },
    async preflight() {
      calls.push("preflight");
    },
    async install(_spec, dirs2, version) {
      calls.push("install");
      mkdirSync(dirs2.config, { recursive: true });
      writeFileSync(join(dirs2.config, ".credentials.json"), "{}");
      return version;
    },
    async session() {
      calls.push("session");
      return session(false);
    },
    publishPass(input) {
      calls.push("publish");
      passes.push(input);
      return { branch: "harness-lab/claude-2.1.301", worktree: "/w", commit: "abc1234", files: [] };
    },
    openIssue(_files, _issue, repo) {
      calls.push("open-issue");
      opened.push(repo);
      return "https://example.test/1";
    },
    ...over,
  };
  return { calls, passes, opened, ports };
}

describe("runLab, the order of a run", () => {
  test("a pass: claim, install, session, one pass commit, a pass row, the run dir deleted", async () => {
    const { options, labRoot, ledger } = setup();
    const spy = fakes();
    const done = await runLab(options, spy.ports);
    expect(done.status).toBe("pass");
    expect(spy.calls).toEqual(["preflight", "install", "session", "clone", "publish"]);
    expect(findRow(readLedger(ledger), "claude", "2.1.301")).toMatchObject({ result: "pass", date: "2026-10-16" });
    expect(existsSync(runRoot(labRoot, "claude", "2.1.301"))).toBe(false);
    expect(spy.passes[0]?.log).toContain("verdict: pass");
    expect(readFileSync(done.logPath, "utf8")).toContain("claimed");
  });

  test("a phone-only run that passes settles a pass row and makes no commit; the session is told the legs and the phone folder", async () => {
    const { options, labRoot, ledger } = setup();
    const plans: SessionPlan[] = [];
    const spy = fakes({
      async session(_spec, _dirs, _version, _log, plan) {
        plans.push(plan);
        return { facts: { profile: "provisional", walk: goodWalk, screens: [], send: null, ask: null, turns: 3, phone: { target: "scratch", turns: 3, summary: "/s.json", results: [phoneResult("idle-send", [passCase("send")])] } }, counters: [] };
      },
    });
    const done = await runLab({ ...options, legs: "phone" }, spy.ports);
    expect(done.status).toBe("pass");
    expect(done.note).toContain("phone-only run: no commit");
    expect(spy.calls).not.toContain("publish");
    expect(findRow(readLedger(ledger), "claude", "2.1.301")?.result).toBe("pass");
    expect(plans[0]?.legs).toBe("phone");
    expect(plans[0]?.phoneOut.startsWith(join(labRoot, "phone", "claude-2.1.301-"))).toBe(true);
    expect(plans[0]?.redact("/home/alice/x")).not.toContain("alice");
  });

  test("a full run whose phone leg fails writes the issue with the phone lines", async () => {
    const { options } = setup();
    const spy = fakes({
      async session() {
        const base = session(false);
        return { ...base, facts: { ...base.facts, phone: { target: "scratch", turns: 5, summary: "/s.json", results: [phoneResult("stream-sends", [failCase("send-2", "ended refused (turn_running)")])] } } };
      },
    });
    const done = await runLab(options, spy.ports);
    expect(done.status).toBe("fail");
    expect(done.note).toContain("phone stream-sends");
    expect(readFileSync(done.issue!.markdown, "utf8")).toContain("- phone stream-sends: fail");
  });

  test("a second run on the same pair is skipped, in every result, and spends nothing", async () => {
    const { options } = setup();
    const first = fakes();
    await runLab(options, first.ports);
    const second = fakes();
    const done = await runLab(options, second.ports);
    expect(done.status).toBe("skipped");
    expect(second.calls).toEqual([]);
  });

  test("a run that names its version reruns a failed row; an unnamed run still skips it", async () => {
    const { options } = setup();
    claim(options.ledgerPath, "claude", "2.1.301", "2026-10-10", "/l", NOW, 1);
    settle(options.ledgerPath, "claude", "2.1.301", { result: "failed", note: "npm install exited 1: ETARGET" });

    const unnamed = fakes();
    expect((await runLab(options, unnamed.ports)).status).toBe("skipped");
    expect(unnamed.calls).toEqual([]);

    const named = fakes();
    const done = await runLab({ ...options, named: true }, named.ports);
    expect(done.status).toBe("pass");
    expect(named.calls).toContain("install");
    // One row per pair: the failed row was taken over, not kept beside the new one.
    const rows = readLedger(options.ledgerPath).rows.filter((row) => row.harness === "claude" && row.version === "2.1.301");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe("pass");
    expect(rows[0]?.date).toBe("2026-10-16");
  });

  test("a named run still skips a pass, a fail, a walk-only and a running row: only failed has no verdict", async () => {
    for (const result of ["pass", "fail", "walk-only"] as const) {
      const { options } = setup();
      claim(options.ledgerPath, "claude", "2.1.301", "2026-10-10", "/l", NOW, 1);
      settle(options.ledgerPath, "claude", "2.1.301", { result });
      const spy = fakes();
      const done = await runLab({ ...options, named: true }, spy.ports);
      expect(done.status).toBe("skipped");
      expect(spy.calls).toEqual([]);
    }
    const { options } = setup();
    claim(options.ledgerPath, "claude", "2.1.301", "2026-10-16", "/l", NOW, 4242);
    const alive: Liveness = { isAlive: (pid) => pid === 4242, servers: () => [], killServer: async () => {} };
    const spy = fakes({ liveness: alive });
    const done = await runLab({ ...options, named: true }, spy.ports);
    expect(done.status).toBe("skipped");
    expect(spy.calls).toEqual([]);
  });

  test("a fail writes the issue as files, never opens it by default, and the row says fail", async () => {
    const { options, ledger } = setup();
    const spy = fakes({ async session() { return session(true); } });
    const done = await runLab(options, spy.ports);
    expect(done.status).toBe("fail");
    expect(spy.calls).not.toContain("publish");
    expect(spy.calls).not.toContain("open-issue");
    expect(done.issue && existsSync(done.issue.json)).toBe(true);
    const issue = JSON.parse(readFileSync(done.issue!.json, "utf8"));
    expect(issue.labels).toEqual(["harness-drift"]);
    expect(issue.body).not.toContain("/home/alice");
    expect(findRow(readLedger(ledger), "claude", "2.1.301")?.result).toBe("fail");
  });

  test("--open-issue opens it once, and only for a fail", async () => {
    const { options } = setup();
    const spy = fakes({ async session() { return session(true); } });
    const done = await runLab({ ...options, openIssue: true, issueRepo: "AltanS/collie" }, spy.ports);
    expect(spy.opened).toEqual(["AltanS/collie"]);
    expect(done.issueUrl).toBe("https://example.test/1");
    const ok = setup();
    const passing = fakes();
    await runLab({ ...ok.options, openIssue: true, issueRepo: "AltanS/collie" }, passing.ports);
    expect(passing.opened).toEqual([]);
  });

  test("an issue that cannot be opened still leaves the fail row and the files", async () => {
    const { options, ledger } = setup();
    const spy = fakes({
      async session() {
        return session(true);
      },
      openIssue() {
        throw new Error("gh is not logged in");
      },
    });
    const done = await runLab({ ...options, openIssue: true, issueRepo: "AltanS/collie" }, spy.ports);
    expect(done.status).toBe("fail");
    expect(done.note).toContain("not opened");
    expect(findRow(readLedger(ledger), "claude", "2.1.301")?.result).toBe("fail");
  });

  test("a session that throws writes a failed row, so the next night skips the pair", async () => {
    const { options, ledger, labRoot } = setup();
    const spy = fakes({
      async session() {
        throw new Error("tmux died");
      },
    });
    const done = await runLab(options, spy.ports);
    expect(done.status).toBe("failed");
    expect(findRow(readLedger(ledger), "claude", "2.1.301")).toMatchObject({ result: "failed", note: "tmux died" });
    expect(existsSync(runRoot(labRoot, "claude", "2.1.301"))).toBe(false);
    const again = fakes();
    expect((await runLab(options, again.ports)).status).toBe("skipped");
    expect(again.calls).toEqual([]);
  });

  test("the install is tried twice, and a second failure is a failed row before any session", async () => {
    const { options, ledger } = setup();
    let tries = 0;
    const spy = fakes({
      async install() {
        tries++;
        throw new LabInfraError("npm exited 1");
      },
    });
    const done = await runLab(options, spy.ports);
    expect(tries).toBe(2);
    expect(done.status).toBe("failed");
    expect(spy.calls).not.toContain("session");
    expect(findRow(readLedger(ledger), "claude", "2.1.301")?.result).toBe("failed");
  });

  test("a first install failure that the retry fixes goes on to the session", async () => {
    const { options } = setup();
    let tries = 0;
    const spy = fakes({
      async install(_spec, _dirs, version) {
        tries++;
        if (tries === 1) throw new LabInfraError("network");
        return version;
      },
    });
    expect((await runLab(options, spy.ports)).status).toBe("pass");
    expect(spy.calls).toContain("session");
  });

  test("a deferred run (login too old, tool missing) writes no row and spends nothing", async () => {
    const { options, ledger, labRoot } = setup();
    const spy = fakes({
      async preflight() {
        throw new LabDeferred("the login has 16 minutes left");
      },
    });
    const done = await runLab(options, spy.ports);
    expect(done.status).toBe("deferred");
    expect(existsSync(ledger)).toBe(false);
    expect(spy.calls).toEqual([]);
    expect(existsSync(runRoot(labRoot, "claude", "2.1.301"))).toBe(false);
    // The next night may try again: the pair has no row.
    const later = fakes();
    expect((await runLab(options, later.ports)).status).toBe("pass");
  });

  test("a harness with no profile is walk-only: no send, a walk-only row, no pass commit", async () => {
    const { options, ledger } = setup();
    const spy = fakes({
      async session() {
        return { facts: { profile: "none", walk: goodWalk, screens: [{ ...idle, expects: "either" }], send: null, ask: null, turns: 0 }, counters: [] };
      },
    });
    const done = await runLab({ ...options, harness: "codex", version: "0.163.0" }, spy.ports);
    expect(done.status).toBe("walk-only");
    expect(spy.calls).not.toContain("publish");
    expect(findRow(readLedger(ledger), "codex", "0.163.0")?.result).toBe("walk-only");
  });

  test("a pass whose commit fails is a failed row with the reason, so the next night skips it and nobody reads it as verified", async () => {
    const { options, ledger } = setup();
    const spy = fakes({
      publishPass() {
        throw new Error("the branch exists already");
      },
    });
    const done = await runLab(options, spy.ports);
    expect(done.status).toBe("failed");
    expect(done.note).toContain("the pass commit failed: the branch exists already");
    expect(findRow(readLedger(ledger), "claude", "2.1.301")?.result).toBe("failed");
  });

  test("the commit comes from the lab's clone, never from the repo it was given", async () => {
    const { options } = setup();
    const spy = fakes();
    await runLab(options, spy.ports);
    expect(spy.passes[0]?.repo).toBe("/repo-clone");
    expect(spy.calls).toContain("clone");
  });

  test("a dry run settles the pass row and makes no commit and no clone", async () => {
    const { options, ledger } = setup();
    const spy = fakes();
    const done = await runLab({ ...options, publish: false }, spy.ports);
    expect(done.status).toBe("pass");
    expect(done.note).toContain("no commit was made");
    expect(spy.calls).not.toContain("publish");
    expect(spy.calls).not.toContain("clone");
    expect(findRow(readLedger(ledger), "claude", "2.1.301")?.result).toBe("pass");
  });

  test("the pass commit and the evidence line carry the real send and ask results", async () => {
    const { options } = setup();
    const spy = fakes();
    await runLab(options, spy.ports);
    expect(spy.passes[0]?.evidence).toContain("one probed send (sent)");
    expect(spy.passes[0]?.evidence).toContain("one ask answer (sent, declined file made: false)");
  });

  test("an ask that never settled is a fail, not a pass", async () => {
    const { options, ledger } = setup();
    const spy = fakes({
      async session() {
        return { ...session(false), facts: { ...session(false).facts, ask: null, askNote: "the dialog was on screen and no reader lifted it" } };
      },
    });
    const done = await runLab(options, spy.ports);
    expect(done.status).toBe("fail");
    expect(done.note).toContain("no reader lifted it");
    expect(findRow(readLedger(ledger), "claude", "2.1.301")?.result).toBe("fail");
  });

  test("no credentials file is left in the lab root after any end", async () => {
    const { options, labRoot } = setup();
    await runLab(options, fakes().ports);
    expect(walkNames(labRoot).filter((name) => name.endsWith(".credentials.json"))).toEqual([]);
  });
});

interface Held {
  readonly ports: LabPorts;
  readonly spy: Spy;
  readonly release: () => void;
  readonly started: Promise<void>;
}

describe("runLab, when the run is cut short", () => {
  /** A session that holds until the test lets it go, after it has written the login copy. */
  function held(): Held {
    let release: () => void = () => {};
    let begin: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = fakes({
      async session() {
        begin();
        await gate;
        return session(false);
      },
    });
    return { ports: spy.ports, spy, release, started };
  }

  for (const reason of ["interrupted by SIGTERM", "interrupted by SIGINT", "uncaughtException: boom"]) {
    test(`${reason}: tmux is stopped, the run folder and the login copy are deleted, the row is failed`, async () => {
      const { options, labRoot, ledger } = setup();
      const signals = new FakeSignals();
      const { ports, spy, release, started } = held();
      const running = runLab({ ...options, signals }, ports);
      await started;
      expect(walkNames(labRoot).some((name) => name.endsWith(".credentials.json"))).toBe(true);
      await signals.fire(reason);
      expect(spy.calls).toContain("stop-all");
      expect(existsSync(runRoot(labRoot, "claude", "2.1.301"))).toBe(false);
      expect(walkNames(labRoot).filter((name) => name.endsWith(".credentials.json"))).toEqual([]);
      expect(findRow(readLedger(ledger), "claude", "2.1.301")).toMatchObject({ result: "failed", note: reason });
      // The session comes back after the emergency: the run must not settle the row a second time or publish.
      release();
      const done = await running;
      expect(done.status).toBe("failed");
      expect(spy.calls).not.toContain("publish");
      expect(findRow(readLedger(ledger), "claude", "2.1.301")?.note).toBe(reason);
      expect(signals.removes).toBe(1);
    });
  }

  test("an emergency deletes the run folder before it stops tmux, so a SIGKILL after the SIGTERM leaves no login copy", async () => {
    const { options, labRoot } = setup();
    const signals = new FakeSignals();
    let begin: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: boolean[] = [];
    const spy = fakes({
      async session() {
        begin();
        await gate;
        return session(false);
      },
      async stopAll() {
        // tmux is stopped now: the folder must be gone already.
        seen.push(existsSync(runRoot(labRoot, "claude", "2.1.301")));
      },
    });
    const running = runLab({ ...options, signals }, spy.ports);
    await started;
    expect(existsSync(runRoot(labRoot, "claude", "2.1.301"))).toBe(true);
    await signals.fire("interrupted by SIGTERM");
    expect(seen).toEqual([false]);
    release();
    await running;
  });

  test("a signal before the claim deletes the folder and writes no row", async () => {
    const { options, labRoot, ledger } = setup();
    const signals = new FakeSignals();
    let begin: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = fakes({
      async preflight(_spec, rundirs) {
        mkdirSync(rundirs.config, { recursive: true });
        writeFileSync(join(rundirs.config, ".credentials.json"), "{}");
        begin();
        await gate;
      },
    });
    const running = runLab({ ...options, signals }, spy.ports);
    await started;
    await signals.fire("interrupted by SIGTERM");
    expect(existsSync(runRoot(labRoot, "claude", "2.1.301"))).toBe(false);
    expect(existsSync(ledger)).toBe(false);
    release();
    await running;
  });

  test("an error that escapes the run still deletes the folder", async () => {
    const { options, labRoot } = setup();
    const spy = fakes({
      async preflight(_spec, rundirs) {
        mkdirSync(rundirs.config, { recursive: true });
        writeFileSync(join(rundirs.config, ".credentials.json"), "{}");
        throw new Error("disk full");
      },
    });
    await expect(runLab(options, spy.ports)).rejects.toThrow("disk full");
    expect(existsSync(runRoot(labRoot, "claude", "2.1.301"))).toBe(false);
  });

  test("the signal handlers are installed for the run and taken off at the end", async () => {
    const { options } = setup();
    const signals = new FakeSignals();
    await runLab({ ...options, signals }, fakes().ports);
    expect(signals.installs).toBe(1);
    expect(signals.removes).toBe(1);
  });
});

describe("runLab, the sweep at the start", () => {
  test("a run folder with no live running row is deleted, and a dead tmux server is killed", async () => {
    const { options, labRoot } = setup();
    const old = join(labRoot, "claude-2.1.299");
    mkdirSync(join(old, "config"), { recursive: true });
    writeFileSync(join(old, "config", ".credentials.json"), "{}");
    const aged = new Date(NOW - 10 * 60_000);
    utimesSync(old, aged, aged);
    const killed: string[] = [];
    const live: Liveness = { isAlive: (pid) => pid === 4242, servers: () => ["harness-lab-4242", "harness-lab-9999"], killServer: async (name) => void killed.push(name) };
    const spy = fakes({ liveness: live });
    // The pair has a row, so only the sweep runs.
    claim(options.ledgerPath, "claude", "2.1.301", "2026-10-16", "/l", NOW, 1);
    settle(options.ledgerPath, "claude", "2.1.301", { result: "pass" });
    const done = await runLab(options, spy.ports);
    expect(done.status).toBe("skipped");
    expect(existsSync(old)).toBe(false);
    expect(killed).toEqual(["harness-lab-9999"]);
  });
});

describe("the stop rule, shouldRun", () => {
  const row = (result: "running" | "pass" | "fail" | "failed" | "walk-only") => ({ rows: [{ harness: "pi", version: "1.4.0", date: "2026-10-23", result, log: "/l" }] });
  test("no row runs, named or not", () => {
    expect(shouldRun({ rows: [] }, "pi", "1.4.0")).toBe(true);
    expect(shouldRun({ rows: [] }, "pi", "1.4.0", true)).toBe(true);
  });
  test("a failed row runs again only for a named version", () => {
    expect(shouldRun(row("failed"), "pi", "1.4.0")).toBe(false);
    expect(shouldRun(row("failed"), "pi", "1.4.0", true)).toBe(true);
  });
  test("every other result stays final", () => {
    for (const result of ["running", "pass", "fail", "walk-only"] as const) expect(shouldRun(row(result), "pi", "1.4.0", true)).toBe(false);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRow, readLedger } from "./lab-ledger";
import type { PassInput } from "./publish";
import { runLab, runRoot, type LabOptions, type LabPorts, type SessionFacts } from "./run";
import { LabDeferred, LabInfraError } from "./seed";
import type { ScreenFact } from "./verdict";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const NOW = Date.parse("2026-10-16T03:00:00Z");

interface Rig {
  readonly options: LabOptions;
  readonly labRoot: string;
  readonly ledger: string;
}

function setup(): Rig {
  const labRoot = mkdtempSync(join(tmpdir(), "lab-run-"));
  dirs.push(labRoot);
  const ledger = join(labRoot, "state", "ledger.json");
  return { labRoot, ledger, options: { harness: "claude", version: "2.1.301", repo: "/repo", labRoot, ledgerPath: ledger, openIssue: false, now: () => NOW, redaction: { home: "/home/alice", user: "alice", host: "bluefin", labDirs: [labRoot] } } };
}

const idle: ScreenFact = { leg: "start", label: "start", expects: "idle", surface: { turn: "idle", composer: "empty", modal: "none" }, free: true, cue: "none", rows: [] };
const dialog = (free: boolean): ScreenFact => ({ leg: "walk", label: "/model", expects: "dialog", surface: { turn: "unknown", composer: "unknown", modal: "ask" }, free, cue: "strong", rows: ["Select model", "  /home/alice/secret"] });
const goodWalk = { reached: true, returned: true, menuRead: true, startedTurn: null, sent: ["/model"], unclassified: [], missing: [] };

const session = (free: boolean, send = "sent"): SessionFacts => ({
  facts: { profile: "provisional", walk: goodWalk, screens: [idle, dialog(free)], send: { outcome: send, probed: true, keys: 2 }, ask: { outcome: "answered", fileCreated: false }, turns: 2 },
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
    expect(spy.calls).toEqual(["preflight", "install", "session", "publish"]);
    expect(findRow(readLedger(ledger), "claude", "2.1.301")).toMatchObject({ result: "pass", date: "2026-10-16" });
    expect(existsSync(runRoot(labRoot, "claude", "2.1.301"))).toBe(false);
    expect(spy.passes[0]?.log).toContain("verdict: pass");
    expect(readFileSync(done.logPath, "utf8")).toContain("claimed");
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

  test("a pass whose commit fails is still a pass row, with the error in the note", async () => {
    const { options, ledger } = setup();
    const spy = fakes({
      publishPass() {
        throw new Error("the branch exists already");
      },
    });
    const done = await runLab(options, spy.ports);
    expect(done.status).toBe("pass");
    expect(done.note).toContain("the commit failed");
    expect(findRow(readLedger(ledger), "claude", "2.1.301")?.result).toBe("pass");
  });

  test("no credentials file is left in the lab root after any end", async () => {
    const { options, labRoot } = setup();
    await runLab(options, fakes().ports);
    const hits = Bun.spawnSync(["find", labRoot, "-name", ".credentials.json"]).stdout.toString().trim();
    expect(hits).toBe("");
  });
});

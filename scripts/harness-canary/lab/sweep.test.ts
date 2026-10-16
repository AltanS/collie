import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim, findRow, readLedger, settle } from "./lab-ledger";
import { realLiveness, runFoldersOf, STARTING_GRACE_MS, sweepLab, type Liveness } from "./sweep";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});
const NOW = Date.parse("2026-10-16T03:00:00Z");

interface Rig {
  readonly labRoot: string;
  readonly ledger: string;
}

function rig(): Rig {
  const labRoot = mkdtempSync(join(tmpdir(), "lab-sweep-"));
  dirs.push(labRoot);
  return { labRoot, ledger: join(labRoot, "state", "ledger.json") };
}

/** A run folder with a login copy in it, `age` ms old. */
function runFolder(labRoot: string, name: string, age: number): string {
  const folder = join(labRoot, name);
  mkdirSync(join(folder, "config"), { recursive: true });
  writeFileSync(join(folder, "config", ".credentials.json"), "{}");
  const when = new Date(NOW - age);
  utimesSync(folder, when, when);
  return folder;
}

interface LiveRig {
  readonly live: Liveness;
  readonly killed: string[];
}

function live(alive: number[], servers: string[] = []): LiveRig {
  const killed: string[] = [];
  return { killed, live: { isAlive: (pid) => alive.includes(pid), servers: () => servers, killServer: async (name) => void killed.push(name) } };
}

describe("the sweep", () => {
  test("a run folder with no row is removed once it is older than the start grace", async () => {
    const { labRoot, ledger } = rig();
    const old = runFolder(labRoot, "claude-2.1.299", 10 * 60_000);
    const fresh = runFolder(labRoot, "claude-2.1.300", 5_000);
    const { live: l } = live([]);
    const done = await sweepLab({ labRoot, ledgerPath: ledger, now: NOW, live: l });
    expect(done.removed).toEqual(["claude-2.1.299"]);
    expect(existsSync(old)).toBe(false);
    // A folder this young may be a run that is still starting: it is spared.
    expect(existsSync(fresh)).toBe(true);
    expect(STARTING_GRACE_MS).toBeGreaterThan(5_000);
  });

  test("a folder whose row is settled is removed, even a young one", async () => {
    const { labRoot, ledger } = rig();
    claim(ledger, "claude", "2.1.301", "2026-10-16", "/l", NOW, 77);
    settle(ledger, "claude", "2.1.301", { result: "pass" });
    const folder = runFolder(labRoot, "claude-2.1.301", 1_000);
    await sweepLab({ labRoot, ledgerPath: ledger, now: NOW, live: live([]).live });
    expect(existsSync(folder)).toBe(false);
  });

  test("a folder whose row is a live running row is kept", async () => {
    const { labRoot, ledger } = rig();
    claim(ledger, "claude", "2.1.301", "2026-10-16", "/l", NOW, 77);
    const folder = runFolder(labRoot, "claude-2.1.301", 60 * 60_000);
    const done = await sweepLab({ labRoot, ledgerPath: ledger, now: NOW, live: live([77]).live });
    expect(existsSync(folder)).toBe(true);
    expect(done.removed).toEqual([]);
    expect(findRow(readLedger(ledger), "claude", "2.1.301")?.result).toBe("running");
  });

  test("a running row whose process is dead is settled as failed and its folder removed", async () => {
    const { labRoot, ledger } = rig();
    claim(ledger, "claude", "2.1.301", "2026-10-16", "/l", NOW, 77);
    const folder = runFolder(labRoot, "claude-2.1.301", 60_000);
    const done = await sweepLab({ labRoot, ledgerPath: ledger, now: NOW, live: live([]).live });
    expect(done.settled).toEqual(["claude-2.1.301"]);
    expect(existsSync(folder)).toBe(false);
    expect(findRow(readLedger(ledger), "claude", "2.1.301")).toMatchObject({ result: "failed" });
    expect(findRow(readLedger(ledger), "claude", "2.1.301")?.note).toContain("died");
  });

  test("a tmux server of a dead pid is killed, and one of a live pid is left", async () => {
    const { labRoot, ledger } = rig();
    const { live: l, killed } = live([4242], ["harness-lab-4242", "harness-lab-9999"]);
    const done = await sweepLab({ labRoot, ledgerPath: ledger, now: NOW, live: l });
    expect(killed).toEqual(["harness-lab-9999"]);
    expect(done.killed).toEqual(["harness-lab-9999"]);
  });

  test("only folders named <harness>-<version> are run folders", () => {
    const { labRoot } = rig();
    for (const name of ["claude-2.1.301", "codex-0.163.0", "logs", "issues", "worktrees", "clone", "claude-latest"]) mkdirSync(join(labRoot, name));
    expect(runFoldersOf(labRoot).toSorted()).toEqual(["claude-2.1.301", "codex-0.163.0"]);
  });

  test("the real liveness sees this process as alive and an absurd pid as dead", () => {
    expect(realLiveness.isAlive(process.pid)).toBe(true);
    expect(realLiveness.isAlive(2 ** 22 + 12345)).toBe(false);
  });
});

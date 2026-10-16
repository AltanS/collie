import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEDGER_FILE, recordVerified, withRecord } from "./ledger";
import { claim, findRow, ledgerPath, loadLedger, markNotified, readLedger, settle, shouldRun, STALE_RUNNING_MS } from "./lab/lab-ledger";

const LEDGER = JSON.stringify(
  {
    $comment: "kept",
    agents: {
      claude: { version: "2.1.278", verified: "2026-09-22", how: "capture", adapter: true, evidence: "old" },
      pi: {
        version: "0.87.0",
        verified: "2026-09-20",
        how: "live sweep",
        adapter: false,
        evidence: "old",
        journal: { version: "0.87.0", verified: "2026-09-20", how: "live sweep", evidence: "old journal" },
      },
    },
  },
  null,
  2,
);

const rec = { agent: "claude", version: "2.1.283", verified: "2026-09-26", adapter: false, evidence: "canary run X" };

describe("withRecord", () => {
  test("rewrites the one entry and keeps the rest", () => {
    const next = JSON.parse(withRecord(LEDGER, rec));
    expect(next.$comment).toBe("kept");
    expect(next.agents.claude).toEqual({
      version: "2.1.283",
      verified: "2026-09-26",
      how: "canary",
      // The entry's own `adapter` wins over the caller's guess.
      adapter: true,
      evidence: "canary run X",
    });
    expect(next.agents.pi.version).toBe("0.87.0");
    expect(Object.keys(next.agents)).toEqual(["claude", "pi"]);
  });

  test("adds an agent the ledger does not have yet", () => {
    const next = JSON.parse(withRecord(LEDGER, { ...rec, agent: "opencode", version: "1.18.32" }));
    expect(next.agents.opencode.adapter).toBe(false);
    expect(next.agents.opencode.how).toBe("canary");
  });

  test("writes the journal reader's line beside the screen reader's", () => {
    const journal = { version: "0.87.1", verified: "2026-09-30", evidence: "canary run Y: journal kinds asserted" };
    const next = JSON.parse(withRecord(LEDGER, { ...rec, agent: "pi", version: "0.87.1", journal }));
    expect(next.agents.pi.journal).toEqual({ ...journal, how: "canary" });
    // The screen half moved too, and neither half took the other's evidence.
    expect(next.agents.pi.evidence).toBe("canary run X");
  });

  test("leaves an entry with no journal block alone: a block is added by hand, never by a run", () => {
    const journal = { version: "2.1.283", verified: "2026-09-26", evidence: "canary run Y" };
    const next = JSON.parse(withRecord(LEDGER, { ...rec, journal }));
    expect(next.agents.claude.journal).toBeUndefined();
  });

  test("a journal line with an unplain version or date is refused like the screen half", () => {
    const journal = { version: "0.87", verified: "2026-09-30", evidence: "e" };
    expect(() => withRecord(LEDGER, { ...rec, agent: "pi", journal })).toThrow(/x\.y\.z/);
    expect(() => withRecord(LEDGER, { ...rec, agent: "pi", journal: { ...journal, version: "0.87.1", verified: "30.09.2026" } })).toThrow(/ISO/);
  });

  test("refuses a version or date that is not plain", () => {
    expect(() => withRecord(LEDGER, { ...rec, version: "2.1.283 (Claude Code)" })).toThrow(/x\.y\.z/);
    expect(() => withRecord(LEDGER, { ...rec, verified: "26.09.2026" })).toThrow(/ISO/);
  });

  test("refuses a document without an agents map", () => {
    expect(() => withRecord('{"version":1}', rec)).toThrow(/agents/);
  });
});

describe("recordVerified", () => {
  let dir = "";
  afterEach(() => {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  test("writes a copy of the real ledger, never the real one", () => {
    dir = mkdtempSync(join(tmpdir(), "canary-ledger-"));
    const copy = join(dir, "verified-versions.json");
    copyFileSync(LEDGER_FILE, copy);
    const before = readFileSync(LEDGER_FILE, "utf8");
    recordVerified(rec, copy);
    expect(JSON.parse(readFileSync(copy, "utf8")).agents.claude.how).toBe("canary");
    expect(readFileSync(LEDGER_FILE, "utf8")).toBe(before);
  });

  test("never creates a missing ledger", () => {
    dir = mkdtempSync(join(tmpdir(), "canary-ledger-"));
    expect(() => recordVerified(rec, join(dir, "missing.json"))).toThrow(/does not exist/);
  });
});

// The nightly lab's own ledger (M56 spec 10): one row per (harness, version), and a pair with a row is
// never run again. The tests name the stop rule: skip.
describe("the lab ledger: skip a pair that has a row", () => {
  let labDir = "";
  afterEach(() => {
    if (labDir !== "") rmSync(labDir, { recursive: true, force: true });
    labDir = "";
  });
  const fresh = (): string => {
    labDir = mkdtempSync(join(tmpdir(), "lab-ledger-"));
    return join(labDir, "state", "ledger.json");
  };
  const NOW = Date.parse("2026-10-16T03:00:00Z");

  test("skip: a claimed pair is never claimed twice", () => {
    const path = fresh();
    expect(claim(path, "claude", "2.1.301", "2026-10-16", "/log", NOW)).toBe(true);
    expect(claim(path, "claude", "2.1.301", "2026-10-16", "/log", NOW)).toBe(false);
    expect(shouldRun(readLedger(path), "claude", "2.1.301")).toBe(false);
    expect(shouldRun(readLedger(path), "claude", "2.1.302")).toBe(true);
  });

  test("skip: every result stops a second run, pass and fail alike", () => {
    const path = fresh();
    const results = ["pass", "fail", "failed", "walk-only"] as const;
    results.forEach((result, i) => {
      const version = `1.0.${String(i)}`;
      expect(claim(path, "claude", version, "2026-10-16", "/log", NOW)).toBe(true);
      settle(path, "claude", version, { result, note: "n" });
      expect(findRow(readLedger(path), "claude", version)?.result).toBe(result);
      expect(claim(path, "claude", version, "2026-10-17", "/log", NOW)).toBe(false);
    });
  });

  test("skip: a running row that died becomes failed and is still skipped", () => {
    const path = fresh();
    claim(path, "codex", "0.163.0", "2026-10-16", "/log", NOW);
    const later = NOW + STALE_RUNNING_MS + 1000;
    const row = findRow(loadLedger(path, later), "codex", "0.163.0");
    expect(row?.result).toBe("failed");
    expect(row?.note).toContain("interrupted");
    expect(claim(path, "codex", "0.163.0", "2026-10-17", "/log", later)).toBe(false);
  });

  test("a running row that is young stays running", () => {
    const path = fresh();
    claim(path, "codex", "0.163.0", "2026-10-16", "/log", NOW);
    expect(findRow(loadLedger(path, NOW + 60_000), "codex", "0.163.0")?.result).toBe("running");
  });

  test("a corrupt ledger throws and is never read as empty", () => {
    const path = fresh();
    mkdirSync(join(labDir, "state"), { recursive: true });
    writeFileSync(path, "{ not json");
    expect(() => readLedger(path)).toThrow(/ledger/);
    expect(() => claim(path, "claude", "2.1.301", "2026-10-16", "/log", NOW)).toThrow();
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });

  test("a row with a bad version or result throws", () => {
    const path = fresh();
    mkdirSync(join(labDir, "state"), { recursive: true });
    writeFileSync(path, JSON.stringify({ rows: [{ harness: "claude", version: "latest", date: "2026-10-16", result: "pass", log: "/l" }] }));
    expect(() => readLedger(path)).toThrow(/x\.y\.z/);
  });

  test("a held lock means someone else has the pair, and a stale lock is cleared", () => {
    const path = fresh();
    mkdirSync(`${path}.lock`, { recursive: true });
    expect(claim(path, "claude", "2.1.301", "2026-10-16", "/log", Date.now())).toBe(false);
    expect(existsSync(path)).toBe(false);
    expect(claim(path, "claude", "2.1.301", "2026-10-16", "/log", Date.now() + 10 * 60_000)).toBe(true);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test("settle without a claim throws, and a settled row has no start time", () => {
    const path = fresh();
    expect(() => settle(path, "claude", "2.1.301", { result: "pass" })).toThrow(/never claimed/);
    claim(path, "claude", "2.1.301", "2026-10-16", "/log", NOW);
    const done = settle(path, "claude", "2.1.301", { result: "pass", note: "ok" });
    expect(done.startedAt).toBeUndefined();
    expect(JSON.parse(readFileSync(path, "utf8")).rows[0].startedAt).toBeUndefined();
  });

  test("a running row carries the pid of its run, and a settled row drops it", () => {
    const path = fresh();
    claim(path, "claude", "2.1.301", "2026-10-16", "/log", NOW, 4321);
    expect(findRow(readLedger(path), "claude", "2.1.301")?.pid).toBe(4321);
    settle(path, "claude", "2.1.301", { result: "pass" });
    expect(findRow(readLedger(path), "claude", "2.1.301")?.pid).toBeUndefined();
  });

  test("markNotified keeps the row and remembers the verdict told", () => {
    const path = fresh();
    claim(path, "claude", "2.1.301", "2026-10-16", "/log", NOW);
    settle(path, "claude", "2.1.301", { result: "fail", note: "x" });
    markNotified(path, "claude", "2.1.301", "fail");
    expect(findRow(readLedger(path), "claude", "2.1.301")).toMatchObject({ result: "fail", notified: "fail" });
  });

  test("the path comes from the environment variable, else the state folder", () => {
    expect(ledgerPath({ COLLIE_HARNESS_LAB_LEDGER: "/x/l.json" }, "/home/u")).toBe("/x/l.json");
    expect(ledgerPath({}, "/home/u")).toBe(join("/home/u", ".local", "state", "collie-harness-lab", "ledger.json"));
  });
});

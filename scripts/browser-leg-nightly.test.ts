// Pure-logic tests of web/e2e/rig/nightly.ts: the tuple, the ledger rules, the blockers, the table and
// the order main() does things in. NO rig, no browser, no model turn, no network: every outside call is
// a fake `World`. It sits in scripts/ because `bun test ./scripts` (part of `bun run test`) runs it
// there, and the root typecheck knows `bun:test` there; web's own typecheck does not. The rig's
// Playwright config collects only `.spec.ts` files under web/e2e/rig, and web's vitest collects `src/`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  LedgerError,
  MIN_CLAUDE_MINUTES,
  MIN_MEM_KB,
  PLAN_CORE,
  PLAN_CREW,
  STALE_RUNNING_MS,
  addVerdicts,
  blockers,
  claim,
  claudeMinutesLeft,
  claudeReplays,
  countsText,
  crewLegRuns,
  CORE_MUX,
  coreStateRoot,
  crewStateRoot,
  decide,
  decideLegs,
  emptyCounts,
  expireStale,
  legEnv,
  legTiers,
  main,
  parseOptions,
  parseRemoteSha,
  parseTable,
  parseVersion,
  planOf,
  readLedger,
  resultsFolderIn,
  settle,
  tiersOf,
  tupleText,
  writeLedger,
  type Decision,
  type Facts,
  type Ledger,
  type Outcome,
  type Row,
  type RunContext,
  type Tuple,
  type World,
} from "../web/e2e/rig/nightly";

const SHA = "0a7ee1d2".padEnd(40, "0");
const TUPLE: Tuple = { sha: SHA, claude: "2.1.302", pi: "0.87.1", omp: "18.6.1", hc: "0.1.14" };
const T0 = Date.UTC(2026, 9, 18, 3, 0, 0);
const DEAD: (pid: number) => boolean = () => false;
const LIVE: (pid: number) => boolean = () => true;

const VERDICTS_15 = { claude: { pass: 5, fail: 0, "not reached": 0, "n/a": 0 }, pi: { pass: 5, fail: 0, "not reached": 0, "n/a": 0 }, omp: { pass: 5, fail: 0, "not reached": 0, "n/a": 0 } };
const row = (over: Partial<Row> = {}): Row => ({ ...TUPLE, date: "2026-10-18", result: "pass", log: "/log", ...over });

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "browser-leg-nightly-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the tuple", () => {
  test("it names the hc version, and a different hc is a different tuple", () => {
    expect(tupleText(TUPLE)).toBe("collie main 0a7ee1d, claude 2.1.302, pi 0.87.1, omp 18.6.1, hc 0.1.14");
    expect(planOf({ rows: [row()] }, { ...TUPLE, hc: "0.2.0" }).kind).toBe("run");
    expect(planOf({ rows: [row()] }, TUPLE).kind).toBe("skip");
  });

  test("`hc --version` output reads as a version", () => {
    expect(parseVersion("hc 0.1.14\n")).toBe("0.1.14");
  });

  test("a row from before the tuple carried hc reads as hc none and is never the same tuple as one with an hc", () => {
    const path = join(dir, "ledger.json");
    const { hc, ...old } = { ...TUPLE, date: "2026-10-17", result: "pass", log: "/log" };
    void hc;
    writeFileSync(path, JSON.stringify({ rows: [old] }));
    const [parsed] = readLedger(path).rows;
    expect(parsed?.hc).toBe("none");
    expect(planOf(readLedger(path), TUPLE).kind).toBe("run");
  });

  test("a row with the core leg's folder and table survives a write and a read", () => {
    const path = join(dir, "ledger.json");
    const all = row({ results: "/r", table: "/r/table.md", crewResults: "/c", crewTable: "/c/table.md", coreResults: "/k", coreTable: "/k/table.md" });
    writeLedger(path, { rows: [all] });
    expect(readLedger(path).rows[0]).toEqual(all);
    writeLedger(path, { rows: [row()] });
    expect(readFileSync(path, "utf8")).not.toContain("coreTable");
  });
});

describe("versions and the remote", () => {
  test("a version is the first x.y.z of the --version output", () => {
    expect(parseVersion("2.1.302 (Claude Code)\n")).toBe("2.1.302");
    expect(parseVersion("0.87.1\n")).toBe("0.87.1");
    expect(parseVersion("omp/18.6.1\n")).toBe("18.6.1");
    expect(parseVersion("pi 0.88.0-beta.1")).toBe("0.88.0-beta.1");
    expect(parseVersion("command not found")).toBeUndefined();
  });

  test("the main sha is the 40 hex digits on the refs/heads/main line", () => {
    expect(parseRemoteSha(`${SHA}\trefs/heads/main\n`)).toBe(SHA);
    expect(parseRemoteSha(`${SHA}\trefs/heads/main-old\n`)).toBeUndefined();
    expect(parseRemoteSha("")).toBeUndefined();
  });
});

describe("the blockers", () => {
  const ok: Facts = { memKb: MIN_MEM_KB, bun: true, herdr: true, git: true, keyFile: "ok", claudeMinutesLeft: MIN_CLAUDE_MINUTES, claudeReplays: false };

  test("a machine that has everything has no blocker, and the floors are inclusive", () => {
    expect(blockers(ok)).toEqual([]);
  });

  test("each missing thing is one blocker, and none costs a row", () => {
    expect(blockers({ ...ok, keyFile: "unset" })).toEqual(["COLLIE_RIG_KEY_FILE is not set"]);
    expect(blockers({ ...ok, keyFile: "unusable" })).toEqual(["COLLIE_RIG_KEY_FILE does not name a readable file"]);
    expect(blockers({ ...ok, herdr: false })).toEqual(["herdr is not on PATH"]);
    expect(blockers({ ...ok, bun: false })).toEqual(["bun is not on PATH"]);
    expect(blockers({ ...ok, git: false })).toEqual(["git is not on PATH"]);
    expect(blockers({ ...ok, memKb: MIN_MEM_KB - 1 })[0]).toContain("GB of memory free");
    expect(blockers({ ...ok, memKb: null })).toEqual(["cannot read the free memory"]);
    expect(blockers({ ...ok, claudeMinutesLeft: null })[0]).toContain("no usable Claude login");
  });

  test("a Claude login with under 25 minutes left blocks, and an expired one says 0", () => {
    expect(blockers({ ...ok, claudeMinutesLeft: 24.9 })).toEqual(["the Claude login has 24 min left, the leg needs 25"]);
    expect(blockers({ ...ok, claudeMinutesLeft: -50 })).toEqual(["the Claude login has 0 min left, the leg needs 25"]);
  });

  test("a Claude that replays on both legs needs no login (M67 spec 07)", () => {
    expect(blockers({ ...ok, claudeReplays: true, claudeMinutesLeft: null })).toEqual([]);
    expect(blockers({ ...ok, claudeReplays: true, claudeMinutesLeft: 3 })).toEqual([]);
    expect(blockers({ ...ok, claudeReplays: true, herdr: false })).toEqual(["herdr is not on PATH"]);
  });

  test("Claude replays when its recordings name both legs on Haiku and this skill text", () => {
    const leg = (skill: string, model = "haiku") => ({ model, skill, recordedAt: "2026-10-29T14:06:25.662Z", cases: [] });
    const meta = (legs: Partial<Record<"solo" | "crew", ReturnType<typeof leg>>>) => JSON.stringify({ v: 1, harness: "claude", version: "2.1.312", legs });
    expect(claudeReplays(meta({ solo: leg("abc"), crew: leg("abc") }), "abc")).toBe(true);
    expect(claudeReplays(meta({ solo: leg("abc") }), "abc")).toBe(false);
    expect(claudeReplays(meta({ solo: leg("abc"), crew: leg("old") }), "abc")).toBe(false);
    expect(claudeReplays(meta({ solo: leg("abc", "sonnet"), crew: leg("abc") }), "abc")).toBe(false);
    expect(claudeReplays(undefined, "abc")).toBe(false);
    expect(claudeReplays("not json", "abc")).toBe(false);
  });

  test("several blockers come out as several words, in one list", () => {
    expect(blockers({ ...ok, keyFile: "unset", herdr: false })).toHaveLength(2);
  });

  test("the minutes left come from the expiry alone", () => {
    const text = JSON.stringify({ claudeAiOauth: { accessToken: "x", expiresAt: T0 + 30 * 60_000 } });
    expect(claudeMinutesLeft(text, T0)).toBe(30);
    expect(claudeMinutesLeft(JSON.stringify({ claudeAiOauth: {} }), T0)).toBeUndefined();
    expect(claudeMinutesLeft("not json", T0)).toBeUndefined();
  });
});

describe("the ledger file", () => {
  test("a missing file is an empty ledger", () => {
    expect(readLedger(join(dir, "none.json")).rows).toEqual([]);
  });

  test("a file that cannot be read is an error, never an empty ledger", () => {
    const path = join(dir, "ledger.json");
    writeFileSync(path, "{ not json");
    expect(() => readLedger(path)).toThrow(LedgerError);
    writeFileSync(path, JSON.stringify({ rows: [{ sha: "a" }] }));
    expect(() => readLedger(path)).toThrow(LedgerError);
    writeFileSync(path, JSON.stringify({ rows: [{ ...row(), result: "maybe" }] }));
    expect(() => readLedger(path)).toThrow(LedgerError);
    writeFileSync(path, JSON.stringify([]));
    expect(() => readLedger(path)).toThrow(LedgerError);
  });

  test("a row survives a write and a read, verdicts and results folder included", () => {
    const path = join(dir, "state", "ledger.json");
    const full = row({ results: "/r", table: "/r/table.md", note: "15 cases passed", verdicts: { claude: { ...emptyCounts(), pass: 5 }, pi: { ...emptyCounts(), pass: 5 }, omp: { ...emptyCounts(), pass: 5 } } });
    writeLedger(path, { rows: [full, row({ sha: "b".repeat(40), result: "running", startedAt: T0, pid: 7 })] });
    expect(readLedger(path).rows[0]).toEqual(full);
    expect(readLedger(path).rows[1]?.pid).toBe(7);
  });

  test("a row with the crew leg's folder and table survives a write and a read", () => {
    const path = join(dir, "state", "ledger.json");
    const both = row({ results: "/r", table: "/r/table.md", crewResults: "/c", crewTable: "/c/table.md", note: "18 cases passed" });
    writeLedger(path, { rows: [both] });
    expect(readLedger(path).rows[0]).toEqual(both);
  });

  test("a row written before the crew leg existed still parses, with no crew fields", () => {
    const path = join(dir, "ledger.json");
    const old = { ...TUPLE, date: "2026-10-17", result: "pass", log: "/log", results: "/r", table: "/r/table.md", note: "15 cases passed", verdicts: VERDICTS_15 };
    writeFileSync(path, JSON.stringify({ rows: [old] }));
    const [parsed] = readLedger(path).rows;
    expect(parsed).toMatchObject({ result: "pass", results: "/r", table: "/r/table.md" });
    expect(parsed?.crewResults).toBeUndefined();
    expect(parsed?.crewTable).toBeUndefined();
    expect(parsed?.verdicts?.pi.pass).toBe(5);
  });

  test("a row without a crew leg writes no crew keys", () => {
    const path = join(dir, "ledger.json");
    writeLedger(path, { rows: [row({ results: "/r", table: "/r/table.md" })] });
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("crewResults");
    expect(text).not.toContain("crewTable");
  });
});

describe("a stale running row", () => {
  const running = (over: Partial<Row> = {}): Row => row({ result: "running", startedAt: T0, pid: 42, ...over });

  test("a run older than the limit becomes failed, and loses its start time and pid", () => {
    const { ledger, moved } = expireStale({ rows: [running()] }, T0 + STALE_RUNNING_MS + 1, LIVE);
    expect(moved).toBe(1);
    const [settled] = ledger.rows;
    expect(settled?.result).toBe("failed");
    expect(settled?.note).toContain("interrupted");
    expect(settled?.startedAt).toBeUndefined();
    expect(settled?.pid).toBeUndefined();
  });

  test("a run whose process is gone becomes failed at once", () => {
    expect(expireStale({ rows: [running()] }, T0 + 1000, DEAD).moved).toBe(1);
  });

  test("a live young run, and every settled row, stay as they are", () => {
    const rows = [running(), row({ result: "pass" }), row({ sha: "c".repeat(40), result: "fail" }), row({ sha: "d".repeat(40), result: "failed" })];
    const { ledger, moved } = expireStale({ rows }, T0 + 1000, LIVE);
    expect(moved).toBe(0);
    expect(ledger.rows).toEqual(rows);
  });
});

describe("the stop rule", () => {
  test("a tuple with a row in any result never runs again", () => {
    for (const result of ["pass", "fail", "failed", "running"] as const) {
      expect(planOf({ rows: [row({ result })] }, TUPLE).kind).toBe("skip");
    }
  });

  test("a new sha, or a new version of any harness, is a new tuple", () => {
    const ledger: Ledger = { rows: [row()] };
    expect(planOf(ledger, { ...TUPLE, sha: "e".repeat(40) }).kind).toBe("run");
    expect(planOf(ledger, { ...TUPLE, claude: "2.1.303" }).kind).toBe("run");
    expect(planOf(ledger, { ...TUPLE, pi: "0.87.2" }).kind).toBe("run");
    expect(planOf(ledger, { ...TUPLE, omp: "18.7.0" }).kind).toBe("run");
    expect(planOf(ledger, { ...TUPLE, hc: "0.1.15" }).kind).toBe("run");
  });

  test("a live run of another tuple holds the line for every tuple", () => {
    const other = row({ sha: "f".repeat(40), result: "running", startedAt: T0, pid: 9 });
    expect(planOf({ rows: [other] }, TUPLE).kind).toBe("busy");
  });
});

describe("claim and settle", () => {
  const meta = { date: "2026-10-18", log: "/log", now: T0, pid: 1234 };

  test("the first claim writes a running row, the second finds the tuple taken", () => {
    const path = join(dir, "ledger.json");
    expect(claim(path, TUPLE, meta, LIVE)).toBe("claimed");
    const [first] = readLedger(path).rows;
    expect(first).toMatchObject({ ...TUPLE, result: "running", startedAt: T0, pid: 1234 });
    expect(claim(path, TUPLE, meta, LIVE)).toBe("taken");
    expect(readLedger(path).rows).toHaveLength(1);
  });

  test("a claim while another tuple runs is busy and writes nothing", () => {
    const path = join(dir, "ledger.json");
    expect(claim(path, { ...TUPLE, sha: "a".repeat(40) }, meta, LIVE)).toBe("claimed");
    expect(claim(path, TUPLE, meta, LIVE)).toBe("busy");
    expect(readLedger(path).rows).toHaveLength(1);
  });

  test("a claim settles a dead run to failed and goes ahead", () => {
    const path = join(dir, "ledger.json");
    claim(path, { ...TUPLE, sha: "a".repeat(40) }, meta, LIVE);
    expect(claim(path, TUPLE, { ...meta, now: T0 + 60_000 }, DEAD)).toBe("claimed");
    const rows = readLedger(path).rows;
    expect(rows.map((r) => r.result)).toEqual(["failed", "running"]);
  });

  test("a claim on a corrupt ledger throws and writes nothing", () => {
    const path = join(dir, "ledger.json");
    writeFileSync(path, "garbage");
    expect(() => claim(path, TUPLE, meta, LIVE)).toThrow(LedgerError);
    expect(readFileSync(path, "utf8")).toBe("garbage");
  });

  test("a claim leaves no lock behind", () => {
    const path = join(dir, "ledger.json");
    claim(path, TUPLE, meta, LIVE);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test("settle turns the running row into its result and keeps the others", () => {
    const path = join(dir, "ledger.json");
    const earlier = row({ sha: "9".repeat(40), result: "pass" });
    writeLedger(path, { rows: [earlier] });
    claim(path, TUPLE, meta, LIVE);
    const done = settle(path, TUPLE, { result: "fail", note: "1 case(s) failed: pi 1", results: "/r", table: "/r/table.md" });
    expect(done).toMatchObject({ result: "fail", results: "/r", table: "/r/table.md" });
    expect(done.startedAt).toBeUndefined();
    expect(readLedger(path).rows).toEqual([earlier, done]);
  });

  test("settle keeps the crew leg's folder and table beside the solo ones", () => {
    const path = join(dir, "ledger.json");
    claim(path, TUPLE, meta, LIVE);
    const done = settle(path, TUPLE, { result: "pass", note: "ok", results: "/r", table: "/r/table.md", crewResults: "/c", crewTable: "/c/table.md" });
    expect(done).toMatchObject({ results: "/r", table: "/r/table.md", crewResults: "/c", crewTable: "/c/table.md" });
    expect(readLedger(path).rows[0]).toEqual(done);
  });

  test("a result needs a claim", () => {
    const path = join(dir, "ledger.json");
    expect(() => settle(path, TUPLE, { result: "pass", note: "x" })).toThrow(LedgerError);
    writeLedger(path, { rows: [row({ result: "pass" })] });
    expect(() => settle(path, TUPLE, { result: "fail", note: "x" })).toThrow(LedgerError);
  });
});

describe("the table and the verdict", () => {
  const line = (harness: string, scenario: string, verdict: string, note = "a note | with a pipe"): string => `| ${harness.padEnd(6)} | ${scenario.padEnd(24)} | ${verdict.padEnd(11)} | 1/1  | ${note} |`;
  const header = ["| harness | scenario | verdict | taps | note |", "|---|---|---|---|---|"];
  const grid = (verdict: (harness: string, n: number) => string): string =>
    [...header, ...["claude", "pi", "omp"].flatMap((h) => [1, 2, 3, 4, 5].map((n) => line(h, `${String(n)} case`, verdict(h, n))))].join("\n");

  test("only the first three cells are read, so a pipe in a note does no harm", () => {
    const rows = parseTable(grid(() => "pass"));
    expect(rows).toHaveLength(15);
    expect(rows.every((r) => r.verdict === "pass")).toBe(true);
  });

  test("the header, the rule line and prose are not cases", () => {
    expect(parseTable(`${header.join("\n")}\nBrowser leg, run x\n`)).toEqual([]);
  });

  test("fifteen passes and a clean exit are a pass", () => {
    const decision = decide(parseTable(grid(() => "pass")), 0);
    expect(decision.result).toBe("pass");
    expect(decision.verdicts?.pi.pass).toBe(5);
  });

  test("any failed case is a fail, and the note says where", () => {
    const decision = decide(parseTable(grid((h, n) => (h === "pi" && n === 3 ? "fail" : "pass"))), 1);
    expect(decision.result).toBe("fail");
    expect(decision.note).toContain("pi 1");
  });

  test("a case that was not reached, or n/a, proves nothing: failed, not fail", () => {
    expect(decide(parseTable(grid((h, n) => (h === "omp" && n === 2 ? "not reached" : "pass"))), 0).result).toBe("failed");
    expect(decide(parseTable(grid((h, n) => (h === "omp" && n === 2 ? "n/a" : "pass"))), 0).result).toBe("failed");
  });

  test("a fail beats a not reached", () => {
    expect(decide(parseTable(grid((_harness, n) => (n === 1 ? "fail" : n === 2 ? "not reached" : "pass"))), 1).result).toBe("fail");
  });

  test("no table, an empty table, or a harness with no case is failed", () => {
    expect(decide(null, 1).result).toBe("failed");
    expect(decide([], 0).result).toBe("failed");
    const noOmp = parseTable(grid(() => "pass")).filter((r) => r.harness !== "omp");
    expect(decide(noOmp, 0)).toMatchObject({ result: "failed", note: "no case for omp in the table" });
  });

  test("a clean table with a bad exit code is failed", () => {
    expect(decide(parseTable(grid(() => "pass")), 1).result).toBe("failed");
    expect(decide(parseTable(grid(() => "pass")), null).result).toBe("failed");
  });

  test("the counts read in a line", () => {
    expect(countsText({ ...emptyCounts(), pass: 3, fail: 1, "not reached": 1 })).toBe("3 pass, 1 fail, 1 not reached");
    expect(countsText(emptyCounts())).toBe("no cases");
  });

  test("the results folder is the one the teardown printed last", () => {
    const log = "x\nBrowser leg, run a (results in /s/results/a):\n\n...\nBrowser leg, run b (results in /s/results/b):\n";
    expect(resultsFolderIn(log)).toBe("/s/results/b");
    expect(resultsFolderIn("nothing")).toBeUndefined();
  });

  test("the crew leg's folder is read from its own teardown line, and the solo read ignores it", () => {
    const log = "Browser leg, run a (results in /s/results/a):\n\n...\nBrowser leg (crew), run b (results in /c/results/b):\n";
    expect(resultsFolderIn(log, "crew")).toBe("/c/results/b");
    expect(resultsFolderIn(log)).toBe("/s/results/a");
    expect(resultsFolderIn("Browser leg, run a (results in /s/results/a):\n", "crew")).toBeUndefined();
  });
});

describe("the model tiers of a run (M67)", () => {
  test("a leg's model.json reads as words, and both legs fit one ledger field", () => {
    const folder = mkdtempSync(join(tmpdir(), "nightly-tiers-"));
    try {
      expect(tiersOf(folder)).toBeUndefined();
      expect(tiersOf(undefined)).toBeUndefined();
      writeFileSync(join(folder, "model.json"), JSON.stringify({ tiers: { pi: { tier: "replay", record: false }, omp: { tier: "live", record: true } }, stub: null, turns: {} }));
      expect(tiersOf(folder)).toBe("pi replay, omp live+record");
      expect(legTiers("pi replay, omp replay", "pi live")).toBe("solo: pi replay, omp replay; crew: pi live");
      expect(legTiers("pi replay", "pi replay", "pi replay, omp replay")).toBe("solo: pi replay; crew: pi replay; core: pi replay, omp replay");
      expect(legTiers(undefined, undefined)).toBeUndefined();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("the crew table and the two-leg verdict", () => {
  const line = (harness: string, verdict: string): string => `| ${harness} | a case | ${verdict} | 1/1 | note |`;
  const crewTable = (...verdicts: string[]): string => ["| harness | scenario | verdict | taps | note |", "|---|---|---|---|---|", ...verdicts.map((v) => line("claude", v))].join("\n");
  const soloPass: Decision = { result: "pass", note: "15 cases passed", verdicts: VERDICTS_15 };
  const crew = (...verdicts: string[]): Decision => decide(parseTable(crewTable(...verdicts)), 0, ["claude"]);
  const soloFailOf = (): Decision => decide(parseTable(["| harness | scenario | verdict | taps | note |", ...["claude", "pi", "omp"].map((h) => line(h, h === "pi" ? "fail" : "pass"))].join("\n")), 1);
  const corePass: Decision = { result: "pass", note: "15 cases passed", verdicts: VERDICTS_15 };

  test("the crew table has Claude cases only, and that is a full table for the crew leg", () => {
    expect(decide(parseTable(crewTable("pass", "pass", "pass")), 0, ["claude"])).toMatchObject({ result: "pass", note: "3 cases passed" });
    expect(decide(parseTable(crewTable("pass", "pass", "pass")), 0).result).toBe("failed");
  });

  test("the crew leg runs once the solo leg wrote a table with cases, whatever the solo verdict was", () => {
    expect(crewLegRuns(parseTable(crewTable("fail")))).toBe(true);
    expect(crewLegRuns(parseTable(crewTable("not reached")))).toBe(true);
    expect(crewLegRuns(null)).toBe(false);
    expect(crewLegRuns([])).toBe(false);
  });

  test("the counts of the two legs add up per harness", () => {
    const sum = addVerdicts(VERDICTS_15, crew("pass", "pass", "fail").verdicts);
    expect(sum?.claude).toEqual({ pass: 7, fail: 1, "not reached": 0, "n/a": 0 });
    expect(sum?.pi.pass).toBe(5);
    expect(addVerdicts(VERDICTS_15, undefined)).toBe(VERDICTS_15);
    expect(addVerdicts(undefined, undefined)).toBeUndefined();
  });

  test("pass only when both legs passed every case", () => {
    const both = decideLegs(soloPass, crew("pass", "pass", "pass"), corePass);
    expect(both).toMatchObject({ result: "pass", note: "33 cases passed (solo 15, crew 3, core 15)" });
    expect(both.verdicts?.claude.pass).toBe(13);
  });

  test("a case not reached in the crew leg makes the row failed, and the note names the crew leg", () => {
    const d = decideLegs(soloPass, crew("pass", "not reached", "pass"), corePass);
    expect(d.result).toBe("failed");
    expect(d.note).toBe("crew leg: 1 case(s) proved nothing: not reached claude 1");
    expect(d.verdicts?.claude["not reached"]).toBe(1);
  });

  test("a case not reached or n/a in the solo leg makes the row failed, and the note names the solo leg", () => {
    const solo = decide(parseTable(["| harness | scenario | verdict | taps | note |", ...["claude", "pi", "omp"].map((h) => line(h, h === "omp" ? "n/a" : "pass"))].join("\n")), 0);
    const d = decideLegs(solo, crew("pass", "pass", "pass"), corePass);
    expect(d.result).toBe("failed");
    expect(d.note).toStartWith("solo leg: ");
    expect(d.note).not.toContain("crew leg");
  });

  test("a failed case in either leg is fail, and a fail outranks a case not reached in the other leg", () => {
    expect(decideLegs(soloPass, crew("pass", "fail", "pass"), corePass)).toMatchObject({ result: "fail", note: "crew leg: 1 case(s) failed: claude 1" });
    const soloFail = decide(parseTable(["| harness | scenario | verdict | taps | note |", ...["claude", "pi", "omp"].map((h) => line(h, h === "pi" ? "fail" : "pass"))].join("\n")), 1);
    expect(decideLegs(soloFail, crew("pass", "pass", "pass"), corePass).result).toBe("fail");
    const d = decideLegs(soloFail, crew("not reached", "pass", "pass"), corePass);
    expect(d.result).toBe("fail");
    expect(d.note).toContain("solo leg: 1 case(s) failed: pi 1; crew leg: 1 case(s) proved nothing");
  });

  test("the crew leg writing no table is failed, even when the solo leg passed", () => {
    const d = decideLegs(soloPass, decide(null, 1, ["claude"]), corePass);
    expect(d).toMatchObject({ result: "failed", note: "crew leg: the leg wrote no table (exit 1)" });
    expect(d.verdicts).toEqual(addVerdicts(soloPass.verdicts, corePass.verdicts));
  });

  test("a crew leg that did not run is never a pass, and the note says it was not run", () => {
    expect(decideLegs(soloPass, null, null)).toMatchObject({ result: "failed", note: "crew leg: not run; core leg: not run" });
    const noTable = decide(null, 1);
    expect(decideLegs(noTable, null, null)).toMatchObject({ result: "failed", note: "solo leg: the leg wrote no table (exit 1); crew leg: not run; core leg: not run" });
  });

  test("a fail from the core leg is a fail, a core leg that wrote no table or did not run is failed", () => {
    const coreFail = decide(parseTable(["| harness | scenario | verdict | taps | note |", ...["claude", "pi", "omp"].map((h) => line(h, h === "pi" ? "fail" : "pass"))].join("\n")), 1);
    const d = decideLegs(soloPass, crew("pass", "pass", "pass"), coreFail);
    expect(d).toMatchObject({ result: "fail", note: "core leg: 1 case(s) failed: pi 1" });
    expect(d.verdicts?.pi).toEqual({ pass: 5, fail: 1, "not reached": 0, "n/a": 0 });
    expect(decideLegs(soloPass, crew("pass", "pass", "pass"), decide(null, 1))).toMatchObject({ result: "failed", note: "core leg: the leg wrote no table (exit 1)" });
    expect(decideLegs(soloPass, crew("pass", "pass", "pass"), null)).toMatchObject({ result: "failed", note: "core leg: not run" });
    expect(decideLegs(soloFailOf(), crew("pass", "pass", "pass"), coreFail).note).toBe("solo leg: 1 case(s) failed: pi 1; core leg: 1 case(s) failed: pi 1");
  });

  test("a crew leg with a clean table but a bad exit is failed", () => {
    expect(decideLegs(soloPass, decide(parseTable(crewTable("pass", "pass", "pass")), 1, ["claude"]), corePass).result).toBe("failed");
  });
});

describe("the leg's environment", () => {
  test("a person's development knobs are dropped, the key file and binaries stay, and the state is its own", () => {
    const env = legEnv(
      {
        PATH: "/bin",
        COLLIE_RIG_KEY_FILE: "/k/.env",
        COLLIE_RIG_CLAUDE_BIN: "/c",
        COLLIE_RIG_KEEP: "1",
        COLLIE_RIG_REUSE: "1",
        COLLIE_RIG_PANE_CLAUDE: "p1",
        COLLIE_RIG_PI_TURNS: "0",
        COLLIE_RIG_STATE: "/elsewhere",
      },
      "/nightly/state",
    );
    expect(env).toEqual({ PATH: "/bin", COLLIE_RIG_KEY_FILE: "/k/.env", COLLIE_RIG_CLAUDE_BIN: "/c", COLLIE_RIG_STATE: "/nightly/state" });
  });
});

describe("the core leg's environment", () => {
  test("the core rig state sits beside the other two, under the same root", () => {
    expect(coreStateRoot("/nightly")).toBe(join("/nightly", "core-state"));
    expect(new Set([join("/nightly", "state"), crewStateRoot("/nightly"), coreStateRoot("/nightly")]).size).toBe(3);
  });

  test("the operator's own COLLIE_RIG_MUX never reaches a leg, and the core leg sets herdr-core after the drop", () => {
    const base = { PATH: "/bin", COLLIE_RIG_KEY_FILE: "/k/.env", COLLIE_RIG_MUX: "herdr,herdr-core" };
    expect("COLLIE_RIG_MUX" in legEnv(base, "/nightly/state")).toBe(false);
    const core = { ...legEnv(base, coreStateRoot("/nightly")), COLLIE_RIG_MUX: CORE_MUX };
    expect(Object.entries(core).toSorted(([a], [b]) => a.localeCompare(b))).toEqual([
      ["COLLIE_RIG_KEY_FILE", "/k/.env"],
      ["COLLIE_RIG_MUX", "herdr-core"],
      ["COLLIE_RIG_STATE", join("/nightly", "core-state")],
      ["PATH", "/bin"],
    ]);
  });
});

describe("the crew leg's environment", () => {
  test("the crew rig state sits beside the solo one, under the same root", () => {
    expect(crewStateRoot("/nightly")).toBe(join("/nightly", "crew-state"));
  });

  test("the crew leg gets the same environment with its own state root, and the key file untouched", () => {
    const base = { PATH: "/bin", COLLIE_RIG_KEY_FILE: "/k/.env", COLLIE_RIG_CREW: "1", COLLIE_RIG_KEEP: "1", COLLIE_RIG_STATE: "/elsewhere" };
    const solo = legEnv(base, "/nightly/state");
    const crew = legEnv(base, crewStateRoot("/nightly"));
    expect(crew).toEqual({ ...solo, COLLIE_RIG_STATE: join("/nightly", "crew-state") });
    expect(crew.COLLIE_RIG_KEY_FILE).toBe("/k/.env");
    expect("COLLIE_RIG_CREW" in crew).toBe(false);
  });
});

describe("the command line", () => {
  // Every path goes through `resolve`, which on Windows adds the drive and turns the separators.
  test("defaults, flags and the environment names", () => {
    expect(parseOptions([], {}, "/h")).toEqual({ plan: false, stateDir: resolve("/h/.local/state/collie-browser-leg"), root: resolve("/h/.cache/collie-lab/browser-leg-nightly"), repo: "https://github.com/AltanS/collie.git" });
    expect(parseOptions(["--plan", "--state-dir", "/s", "--root", "/r", "--repo", "/repo"], {}, "/h")).toEqual({ plan: true, stateDir: resolve("/s"), root: resolve("/r"), repo: "/repo" });
    expect(parseOptions([], { COLLIE_BROWSER_LEG_STATE_DIR: "/e" }, "/h")).toMatchObject({ stateDir: resolve("/e") });
    expect(parseOptions(["-h"], {}, "/h")).toBe("help");
  });

  test("an unknown flag, or a flag without its value, is an error", () => {
    expect(() => parseOptions(["--now"], {})).toThrow("unknown option");
    expect(() => parseOptions(["--root"], {})).toThrow("needs a value");
    expect(() => parseOptions(["--root", "--plan"], {})).toThrow("needs a value");
  });
});

// ── main(), with a world made of fakes ───────────────────────────────────────────────────────────

const GOOD: Facts = { memKb: MIN_MEM_KB * 2, bun: true, herdr: true, git: true, keyFile: "ok", claudeMinutesLeft: 200, claudeReplays: false };

interface Rig {
  readonly world: World;
  readonly lines: string[];
  readonly errors: string[];
  readonly out: { line(text: string): void; error(text: string): void };
  /** How many times the run was executed, and the ledger rows as execute saw them. */
  readonly counter: { executed: number; seen: Row[] };
}

function rig(over: { facts?: Facts; outcome?: Outcome | Error; remote?: string | Error; alive?: boolean; now?: number } = {}): Rig {
  const lines: string[] = [];
  const errors: string[] = [];
  const seen: Row[] = [];
  const counter = { executed: 0, seen };
  const world: World = {
    now: () => over.now ?? T0,
    remoteSha: () => {
      if (over.remote instanceof Error) throw over.remote;
      return over.remote ?? SHA;
    },
    version: (id) => TUPLE[id],
    facts: () => over.facts ?? GOOD,
    alive: over.alive === false ? DEAD : LIVE,
    pid: 4242,
    execute: (context: RunContext) => {
      counter.executed++;
      counter.seen = readLedger(join(context.options.stateDir, "ledger.json")).rows.slice();
      const outcome = over.outcome ?? PASS;
      if (outcome instanceof Error) return Promise.reject(outcome);
      return Promise.resolve(outcome);
    },
  };
  return { world, lines, errors, out: { line: (text) => lines.push(text), error: (text) => errors.push(text) }, counter };
}

const VERDICTS_PASS = { claude: { ...emptyCounts(), pass: 5 }, pi: { ...emptyCounts(), pass: 5 }, omp: { ...emptyCounts(), pass: 5 } };
const PASS: Outcome = { result: "pass", note: "15 cases passed", results: "/r", table: "/r/table.md", verdicts: VERDICTS_PASS };

const argv = (...more: string[]): string[] => ["--state-dir", join(dir, "state"), "--root", join(dir, "root"), ...more];
const notifyLog = (): string[] => {
  const path = join(dir, "state", "notify.log");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
};
const ledgerRows = (): readonly Row[] => readLedger(join(dir, "state", "ledger.json")).rows;

describe("main --plan", () => {
  test("says it would run, and writes nothing at all", async () => {
    const r = rig();
    expect(await main(argv("--plan"), {}, r.world, r.out)).toBe(0);
    expect(r.lines).toEqual(["plan: collie main 0a7ee1d, claude 2.1.302, pi 0.87.1, omp 18.6.1, hc 0.1.14", "plan: would run", PLAN_CREW, PLAN_CORE]);
    expect(PLAN_CREW).toContain("includes the crew leg");
    expect(PLAN_CORE).toContain("includes the core solo leg after the crew leg");
    expect(PLAN_CORE).toContain("herdr-core");
    expect(r.counter.executed).toBe(0);
    expect(existsSync(join(dir, "state"))).toBe(false);
  });

  test("names the blockers and still writes nothing, not even a notify line", async () => {
    const r = rig({ facts: { ...GOOD, keyFile: "unset", claudeMinutesLeft: 3 } });
    expect(await main(argv("--plan"), {}, r.world, r.out)).toBe(0);
    expect(r.lines).toContain("plan: would not start");
    expect(r.lines.filter((l) => l.startsWith("plan: blocked:"))).toHaveLength(2);
    expect(existsSync(join(dir, "state"))).toBe(false);
  });

  test("says a tuple with a row would not run, and a stale row stays a stale row on disk", async () => {
    const path = join(dir, "state", "ledger.json");
    const stale = row({ result: "running", startedAt: T0 - STALE_RUNNING_MS - 5, pid: 1 });
    writeLedger(path, { rows: [stale] });
    const before = readFileSync(path, "utf8");
    const r = rig();
    expect(await main(argv("--plan"), {}, r.world, r.out)).toBe(0);
    expect(r.lines.join("\n")).toContain("would not run: the ledger has a row for this tuple (failed, 2026-10-18)");
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("main, a real run", () => {
  test("claims before it executes, settles after, and a second start does nothing", async () => {
    const r = rig();
    expect(await main(argv(), {}, r.world, r.out)).toBe(0);
    expect(r.counter.executed).toBe(1);
    expect(r.counter.seen).toHaveLength(1);
    expect(r.counter.seen[0]).toMatchObject({ ...TUPLE, result: "running", pid: 4242 });
    expect(ledgerRows()).toHaveLength(1);
    expect(ledgerRows()[0]).toMatchObject({ result: "pass", results: "/r", table: "/r/table.md" });
    expect(ledgerRows()[0]?.verdicts?.omp.pass).toBe(5);
    expect(r.lines).toEqual(["claude 2.1.302: 5 pass", "pi 0.87.1: 5 pass", "omp 18.6.1: 5 pass", "table: /r/table.md (collie main 0a7ee1d, pass)"]);
    expect(notifyLog()).toEqual([]);

    const again = rig();
    expect(await main(argv(), {}, again.world, again.out)).toBe(0);
    expect(again.counter.executed).toBe(0);
    expect(again.lines[0]).toContain("nothing to do");
  });

  test("a run with a crew leg keeps both tables, adds a crew line, and a pass says nothing to the operator", async () => {
    const r = rig({ outcome: { ...PASS, crewResults: "/c", crewTable: "/c/table.md", verdicts: { ...VERDICTS_PASS, claude: { ...emptyCounts(), pass: 8 } } } });
    expect(await main(argv(), {}, r.world, r.out)).toBe(0);
    expect(ledgerRows()[0]).toMatchObject({ result: "pass", results: "/r", table: "/r/table.md", crewResults: "/c", crewTable: "/c/table.md" });
    expect(r.lines).toEqual(["claude 2.1.302: 8 pass", "pi 0.87.1: 5 pass", "omp 18.6.1: 5 pass", "table: /r/table.md (collie main 0a7ee1d, pass)", "crew table: /c/table.md"]);
    expect(notifyLog()).toEqual([]);
  });

  test("a run with a core leg keeps its folder and table, adds a core line, and a core fail tells the operator", async () => {
    const withCore = { crewResults: "/c", crewTable: "/c/table.md", coreResults: "/k", coreTable: "/k/table.md" };
    const ok = rig({ outcome: { ...PASS, ...withCore } });
    expect(await main(argv(), {}, ok.world, ok.out)).toBe(0);
    expect(ledgerRows()[0]).toMatchObject({ hc: "0.1.14", coreResults: "/k", coreTable: "/k/table.md" });
    expect(ok.lines.at(-1)).toBe("core table: /k/table.md");

    rmSync(join(dir, "state"), { recursive: true, force: true });
    const bad = rig({ outcome: { result: "fail", note: "core leg: 2 case(s) failed: pi 2", ...withCore, table: "/r/table.md", verdicts: VERDICTS_PASS } });
    expect(await main(argv(), {}, bad.world, bad.out)).toBe(1);
    expect(notifyLog()).toHaveLength(1);
    expect(notifyLog()[0]).toContain("hc 0.1.14 fail: core leg: 2 case(s) failed: pi 2");
    expect(notifyLog()[0]).toContain("core table /k/table.md");
  });

  test("a bad run names the failing leg in the one notify line, with both tables", async () => {
    const r = rig({ outcome: { result: "failed", note: "crew leg: 1 case(s) proved nothing: not reached claude 1", table: "/r/table.md", crewTable: "/c/table.md", verdicts: VERDICTS_PASS } });
    expect(await main(argv(), {}, r.world, r.out)).toBe(2);
    expect(notifyLog()).toHaveLength(1);
    expect(notifyLog()[0]).toContain("failed: crew leg: 1 case(s) proved nothing");
    expect(notifyLog()[0]).toContain("table /r/table.md, crew table /c/table.md");
  });

  test("a failed case writes fail, exits 1, and tells the operator once", async () => {
    const r = rig({ outcome: { result: "fail", note: "1 case(s) failed: pi 1", table: "/r/table.md", results: "/r", verdicts: { ...VERDICTS_PASS, pi: { ...emptyCounts(), pass: 4, fail: 1 } } } });
    expect(await main(argv(), {}, r.world, r.out)).toBe(1);
    expect(ledgerRows()[0]?.result).toBe("fail");
    expect(r.lines).toContain("pi 0.87.1: 4 pass, 1 fail");
    expect(notifyLog()).toHaveLength(1);
    expect(notifyLog()[0]).toContain("fail: 1 case(s) failed: pi 1");

    const again = rig();
    expect(await main(argv(), {}, again.world, again.out)).toBe(0);
    expect(again.counter.executed).toBe(0);
    expect(notifyLog()).toHaveLength(1);
  });

  test("a run that throws writes failed, exits 2, and never runs that tuple again", async () => {
    const r = rig({ outcome: new Error("bun install (root) exited 1") });
    expect(await main(argv(), {}, r.world, r.out)).toBe(2);
    expect(ledgerRows()[0]).toMatchObject({ result: "failed", note: "bun install (root) exited 1" });
    expect(notifyLog()).toHaveLength(1);
    expect(r.lines.some((l) => l.startsWith("table: none (bun install (root) exited 1)"))).toBe(true);

    const again = rig();
    expect(await main(argv(), {}, again.world, again.out)).toBe(0);
    expect(again.counter.executed).toBe(0);
  });

  test("a run that proves nothing (not reached) is failed and exits 2", async () => {
    const r = rig({ outcome: { result: "failed", note: "2 case(s) proved nothing: not reached omp 2", table: "/r/table.md", verdicts: VERDICTS_PASS } });
    expect(await main(argv(), {}, r.world, r.out)).toBe(2);
    expect(ledgerRows()[0]?.result).toBe("failed");
  });

  test("a run that died leaves running, and the next start settles it failed and takes the next tuple", async () => {
    const path = join(dir, "state", "ledger.json");
    writeLedger(path, { rows: [row({ sha: "1".repeat(40), result: "running", startedAt: T0 - 1000, pid: 99 })] });
    const r = rig({ alive: false });
    expect(await main(argv(), {}, r.world, r.out)).toBe(0);
    expect(ledgerRows().map((x) => x.result)).toEqual(["failed", "pass"]);
    expect(ledgerRows()[0]?.note).toContain("interrupted");
  });

  test("a live run of another tuple stops this start without a row or a notice", async () => {
    const path = join(dir, "state", "ledger.json");
    writeLedger(path, { rows: [row({ sha: "1".repeat(40), result: "running", startedAt: T0 - 1000, pid: 99 })] });
    const r = rig();
    expect(await main(argv(), {}, r.world, r.out)).toBe(0);
    expect(r.counter.executed).toBe(0);
    expect(ledgerRows()).toHaveLength(1);
    expect(notifyLog()).toEqual([]);
  });
});

describe("main, the cannot-start cases", () => {
  test("a blocker costs nothing: no row, no execute, one notify line, exit 2", async () => {
    const r = rig({ facts: { ...GOOD, claudeMinutesLeft: 10, herdr: false } });
    expect(await main(argv(), {}, r.world, r.out)).toBe(2);
    expect(r.counter.executed).toBe(0);
    expect(existsSync(join(dir, "state", "ledger.json"))).toBe(false);
    expect(notifyLog()).toHaveLength(1);
    expect(notifyLog()[0]).toContain("cannot start: the Claude login has 10 min left, the leg needs 25; herdr is not on PATH");
  });

  test("a blocker that goes away lets the same tuple run", async () => {
    const blocked = rig({ facts: { ...GOOD, keyFile: "unset" } });
    expect(await main(argv(), {}, blocked.world, blocked.out)).toBe(2);
    const ok = rig();
    expect(await main(argv(), {}, ok.world, ok.out)).toBe(0);
    expect(ok.counter.executed).toBe(1);
  });

  test("a tuple that already has a row ends the run before the blockers are asked", async () => {
    writeLedger(join(dir, "state", "ledger.json"), { rows: [row()] });
    const r = rig({ facts: { ...GOOD, keyFile: "unset" } });
    expect(await main(argv(), {}, r.world, r.out)).toBe(0);
    expect(notifyLog()).toEqual([]);
  });

  test("an unreachable remote, or a binary that will not run, is a cannot-start", async () => {
    const r = rig({ remote: new Error("cannot read main of x") });
    expect(await main(argv(), {}, r.world, r.out)).toBe(2);
    expect(notifyLog()[0]).toContain("cannot read main of x");
    expect(existsSync(join(dir, "state", "ledger.json"))).toBe(false);
  });

  test("an unreadable ledger is a cannot-start and is left as it is", async () => {
    const path = join(dir, "state", "ledger.json");
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(path, "{ broken");
    const r = rig();
    expect(await main(argv(), {}, r.world, r.out)).toBe(2);
    expect(r.counter.executed).toBe(0);
    expect(readFileSync(path, "utf8")).toBe("{ broken");
    expect(notifyLog()).toHaveLength(1);
  });

  test("a bad flag exits 2 and prints the usage", async () => {
    const r = rig();
    expect(await main(["--nope"], {}, r.world, r.out)).toBe(2);
    expect(r.errors[0]).toContain("unknown option");
    expect(r.errors[0]).toContain("Usage:");
  });
});

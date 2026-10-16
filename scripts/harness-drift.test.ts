import { describe, expect, test } from "bun:test";

import { compareVersions, driftLine, driftRows, driftState, gateRows, installedVersion, labNote, loadLedger, parseArgs, parsePairs } from "./harness-drift.ts";
import { claim, settle } from "./harness-canary/lab/lab-ledger.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// M37 spec 01, extended by M41 spec 05: one row per READER, not per agent. The screen grammar and
// the journal grammar are verified apart and drift apart, so a `same` on one says nothing about the
// other — that is the property this file pins, along with the compare the state rests on.

const line = (version: string) => ({ version, verified: "2026-09-30", how: "canary" as const, evidence: "e" });

describe("compareVersions", () => {
  test("compares segment by segment, numerically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("2.1.284", "2.1.284")).toBe(0);
    expect(compareVersions("0.0.0", "1.0.41")).toBe(-1);
    // A missing segment is a zero, so "1.2" and "1.2.0" are one version.
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
  });
});

describe("driftState", () => {
  test("names what to do about it", () => {
    expect(driftState(null, "1.0.0")).toBe("not installed");
    expect(driftState("1.0.0", "1.0.0")).toBe("same");
    expect(driftState("1.0.1", "1.0.0")).toBe("NEWER, run the canary");
    expect(driftState("0.9.0", "1.0.0")).toBe("older");
  });
});

describe("driftRows", () => {
  test("an agent with both readers gets a row each, and they can disagree", () => {
    const entry = { ...line("2.1.284"), adapter: true, journal: line("2.1.285") };
    const rows = driftRows("claude", entry, () => "2.1.285");
    expect(rows.map((r) => r.reader)).toEqual(["screen", "journal"]);
    expect(rows.map((r) => r.state)).toEqual(["NEWER, run the canary", "same"]);
  });

  test("an agent with no journal reader gets one row", () => {
    const rows = driftRows("muse", { ...line("1.4.0"), adapter: true }, () => null);
    expect(rows).toEqual([{ agent: "muse", reader: "screen", installed: null, verified: "1.4.0", state: "not installed" }]);
  });

  test("the version probe runs once per agent, not once per reader", () => {
    let probes = 0;
    driftRows("pi", { ...line("0.87.1"), adapter: false, journal: line("0.87.1") }, () => {
      probes += 1;
      return "0.87.1";
    });
    expect(probes).toBe(1);
  });
});

test("the committed ledger gives every reader a version this script can compare", () => {
  const ledger = loadLedger();
  for (const [agent, entry] of Object.entries(ledger.agents)) {
    for (const row of driftRows(agent, entry, () => null)) {
      expect(row.verified, `${agent} ${row.reader}`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  }
});

// The soft release gate (M44 spec 08, carried by M56 spec 10).
describe("the soft release gate", () => {
  const newer = { agent: "claude", reader: "screen" as const, installed: "2.1.301", verified: "2.1.296", state: "NEWER, run the canary" as const };

  test("HARNESS_DRIFT_FAKE stands in for the installed version, for the named agent only", () => {
    expect(installedVersion("claude", { HARNESS_DRIFT_FAKE: "claude=99.0.0" })).toBe("99.0.0");
    expect(installedVersion("claude", { HARNESS_DRIFT_FAKE: "claude=99.0.0,codex=1.0.0" })).toBe("99.0.0");
    expect(() => installedVersion("claude", { HARNESS_DRIFT_FAKE: "claude=latest" })).toThrow(/agent=x.y.z/);
  });

  test("parsePairs reads agent=version lists and refuses anything else", () => {
    expect([...parsePairs("claude=2.1.301,codex=0.163.0", "x")]).toEqual([["claude", "2.1.301"], ["codex", "0.163.0"]]);
    expect(() => parsePairs("claude", "--accept-drift")).toThrow(/--accept-drift/);
    expect(() => parsePairs("claude=2.1", "x")).toThrow();
  });

  test("a drift blocks, and an override that names the agent and the installed version covers it", () => {
    expect(gateRows([newer], new Map()).blocked).toHaveLength(1);
    expect(gateRows([newer], new Map([["claude", "2.1.301"]]))).toMatchObject({ blocked: [], accepted: [newer] });
  });

  test("an override for another version or another agent covers nothing, and a missing agent never blocks", () => {
    expect(gateRows([newer], new Map([["claude", "2.1.300"]])).blocked).toHaveLength(1);
    expect(gateRows([newer], new Map([["codex", "2.1.301"]])).blocked).toHaveLength(1);
    expect(gateRows([{ ...newer, installed: null, state: "not installed" }], new Map()).blocked).toHaveLength(0);
    expect(gateRows([{ ...newer, state: "same" }], new Map()).blocked).toHaveLength(0);
  });

  test("--accept-drift is parsed from the command line", () => {
    expect([...parseArgs(["--strict", "--accept-drift", "claude=2.1.301"]).accept]).toEqual([["claude", "2.1.301"]]);
    expect(parseArgs(["--strict"]).accept.size).toBe(0);
  });

  test("the accepted drift reads as one line", () => {
    expect(driftLine("claude", "2.1.301")).toBe("claude 2.1.301 is newer than its verified version: not verified");
  });

  test("labNote says merge the branch only when the branch exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "lab-note-"));
    try {
      const file = join(dir, "ledger.json");
      claim(file, "claude", "2.1.301", "2026-10-16", "/l", 1, 1);
      settle(file, "claude", "2.1.301", { result: "pass" });
      const here = labNote("claude", "2.1.301", file, () => true);
      expect(here).toContain("merge the branch harness-lab/claude-2.1.301");
      const gone = labNote("claude", "2.1.301", file, () => false);
      expect(gone).not.toContain("merge the branch");
      expect(gone).toContain("is not in the lab clone");
      expect(labNote("claude", "2.1.302", file, () => true)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

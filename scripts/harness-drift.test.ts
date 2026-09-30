import { describe, expect, test } from "bun:test";

import { compareVersions, driftRows, driftState, loadLedger } from "./harness-drift.ts";

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

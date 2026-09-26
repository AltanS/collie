import { describe, expect, test } from "bun:test";
import type { KnownGap } from "./known-gaps";
import {
  applyKnownGaps,
  exitCode,
  failCase,
  notReachedCase,
  passCase,
  recordable,
  renderTable,
  scenarioResult,
  scenarioVerdict,
} from "./verdict";

const gap: KnownGap = { agent: "codex", scenario: "start-exit", reason: "no modalOnScreen", ref: "ADR 0053" };

describe("scenarioVerdict", () => {
  test("all pass is pass", () => {
    expect(scenarioVerdict([passCase("a"), passCase("b")])).toBe("pass");
  });

  test("a fail wins over a later not-reached", () => {
    expect(scenarioVerdict([passCase("a"), failCase("b", "x"), notReachedCase("c", "y")])).toBe("fail");
  });

  test("a screen never reached is never a pass", () => {
    expect(scenarioVerdict([passCase("a"), notReachedCase("b", "timeout")])).toBe("not-reached");
  });

  test("nothing judged is not-reached", () => {
    expect(scenarioVerdict([])).toBe("not-reached");
  });
});

describe("scenarioResult detail", () => {
  test("a pass counts its cases", () => {
    expect(scenarioResult("claude", "drafts", [passCase("01"), passCase("02")]).detail).toBe("2/2");
  });

  test("a single-case pass keeps its own words", () => {
    expect(scenarioResult("claude", "idle", [passCase("idle", "composer ready")]).detail).toBe("composer ready");
  });

  test("a fail names the first failing case", () => {
    const r = scenarioResult("claude", "drafts", [passCase("01"), failCase("15-rule", "draft not read back")]);
    expect(r.verdict).toBe("fail");
    expect(r.detail).toBe("1/2, 15-rule: draft not read back");
  });
});

describe("applyKnownGaps", () => {
  test("a listed fail becomes known-gap and keeps the entry", () => {
    const r = applyKnownGaps(scenarioResult("codex", "start-exit", [failCase("start", "card")]), [gap]);
    expect(r.verdict).toBe("known-gap");
    expect(r.gap).toEqual(gap);
  });

  test("a listed pass stays a pass and is flagged stale", () => {
    const r = applyKnownGaps(scenarioResult("codex", "start-exit", [passCase("start")]), [gap]);
    expect(r.verdict).toBe("pass");
    expect(r.staleGap).toBe(true);
  });

  test("a gap listed for another agent does not apply", () => {
    const r = applyKnownGaps(scenarioResult("claude", "start-exit", [failCase("start", "card")]), [gap]);
    expect(r.verdict).toBe("fail");
  });

  test("not-reached stays not-reached", () => {
    const r = applyKnownGaps(scenarioResult("codex", "start-exit", [notReachedCase("start", "timeout")]), [gap]);
    expect(r.verdict).toBe("not-reached");
    expect(r.staleGap).toBeUndefined();
  });
});

describe("exitCode and recordable", () => {
  const ok = scenarioResult("claude", "idle", [passCase("idle")]);
  const bad = scenarioResult("codex", "idle", [failCase("idle", "composer not found")]);
  const unseen = scenarioResult("pi", "sends", [notReachedCase("01", "turn did not finish")]);
  const known = applyKnownGaps(scenarioResult("codex", "start-exit", [failCase("s", "card")]), [gap]);

  test("only a fail fails the run", () => {
    expect(exitCode([ok, known, unseen])).toBe(0);
    expect(exitCode([ok, bad])).toBe(1);
  });

  test("a run with a fail records nobody", () => {
    expect(recordable("claude", [ok, bad])).toBe(false);
  });

  test("an agent with an unreached scenario is not recorded", () => {
    expect(recordable("pi", [ok, unseen])).toBe(false);
    expect(recordable("claude", [ok, unseen])).toBe(true);
  });

  test("an agent with no results is not recorded", () => {
    expect(recordable("opencode", [ok])).toBe(false);
  });
});

test("renderTable prints one row per result with the gap's reference", () => {
  const known = applyKnownGaps(scenarioResult("codex", "start-exit", [failCase("s", "card")]), [gap]);
  const table = renderTable([scenarioResult("claude", "idle", [passCase("idle", "ok")]), known], new Map([["claude", "2.1.283"], ["codex", "0.156.1"]]));
  const lines = table.split("\n");
  expect(lines).toHaveLength(3);
  expect(lines[0]).toMatch(/^agent\s+version\s+scenario\s+verdict\s+detail$/);
  expect(lines[1]).toMatch(/^claude\s+2\.1\.283\s+idle\s+pass\s+ok$/);
  expect(lines[2]).toContain("known-gap");
  expect(lines[2]).toContain("(ADR 0053)");
});

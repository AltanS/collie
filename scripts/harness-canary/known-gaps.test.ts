import { describe, expect, test } from "bun:test";
import { isCanaryAgent } from "./args";
import { loadKnownGaps, parseKnownGaps } from "./known-gaps";

describe("known-gaps.json", () => {
  test("the committed file parses, and every entry names a canary agent", () => {
    const gaps = loadKnownGaps();
    for (const g of gaps) expect(isCanaryAgent(g.agent)).toBe(true);
  });

  test("an entry needs a reason and a reference", () => {
    expect(() => parseKnownGaps('{"gaps":[{"agent":"codex","scenario":"idle","reason":"","ref":"#1"}]}')).toThrow(/reason/);
    expect(() => parseKnownGaps('{"gaps":[{"agent":"codex","scenario":"idle","reason":"r","ref":"soon"}]}')).toThrow(/ref/);
  });

  test("an unknown scenario is refused", () => {
    expect(() => parseKnownGaps('{"gaps":[{"agent":"codex","scenario":"dialogs","reason":"r","ref":"M37/03"}]}')).toThrow(/scenario/);
  });

  test("a scenario listed twice for one agent is refused", () => {
    const entry = '{"agent":"codex","scenario":"idle","reason":"r","ref":"#294"}';
    expect(() => parseKnownGaps(`{"gaps":[${entry},${entry}]}`)).toThrow(/twice/);
  });

  test("a file without a gaps list is refused", () => {
    expect(() => parseKnownGaps("{}")).toThrow(/gaps/);
    expect(() => parseKnownGaps("not json")).toThrow(/gaps/);
  });

  test("issue, spec and ADR references are accepted", () => {
    const gaps = parseKnownGaps(
      JSON.stringify({
        gaps: [
          { agent: "codex", scenario: "idle", reason: "r", ref: "#294" },
          { agent: "codex", scenario: "drafts", reason: "r", ref: "M37/03" },
          { agent: "codex", scenario: "start-exit", reason: "r", ref: "ADR 0053 addendum" },
        ],
      }),
    );
    expect(gaps.map((g) => g.scenario)).toEqual(["idle", "drafts", "start-exit"]);
  });
});

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_PROMPT_TAIL_LINES,
  normalizePromptRegion,
  verifyExpectedPrompt,
} from "./prompt-binding.ts";

describe("normalizePromptRegion", () => {
  test("strips SGR sequences and normalizes CRLF and CR line endings", () => {
    expect(normalizePromptRegion("\x1b[31mApprove?\x1b[0m\r\n\x1b[1m1. Yes\x1b[0m\r2. No")).toEqual([
      "Approve?",
      "1. Yes",
      "2. No",
    ]);
  });

  test("ignores trailing terminal padding", () => {
    const compact = normalizePromptRegion("Approve this command?\n1. Yes\n2. No");
    const redrawn = normalizePromptRegion("Approve this command?   \n1. Yes       \n2. No   ");
    expect(redrawn).toEqual(compact);
  });

  // Whitespace inside diffs and commands is semantic. Redraw tolerance must not erase it.
  test("preserves leading indentation", () => {
    expect(normalizePromptRegion("  diff line")).toEqual(["  diff line"]);
  });

  test("preserves internal alignment", () => {
    expect(normalizePromptRegion("key:    aligned")).toEqual(["key:    aligned"]);
  });

  test("does not equate regions that differ only in indentation", () => {
    expect(normalizePromptRegion("Apply edit?\n  return value;")).not.toEqual(
      normalizePromptRegion("Apply edit?\n    return value;"),
    );
  });

  test("ignores blank-line layout changes", () => {
    const compact = normalizePromptRegion("Approve?\n1. Yes\n2. No");
    const redrawn = normalizePromptRegion("\nApprove?\n\n\n1. Yes\n \t \n2. No\n");
    expect(redrawn).toEqual(compact);
  });

  test("preserves wording changes", () => {
    expect(normalizePromptRegion("Approve this command?\n1. Yes")).not.toEqual(
      normalizePromptRegion("Approve this file?\n1. Yes"),
    );
  });
});

describe("verifyExpectedPrompt", () => {
  test("accepts an exact contiguous match", () => {
    expect(verifyExpectedPrompt("older output\nApprove?\n1. Yes\n2. No", "Approve?\n1. Yes\n2. No")).toEqual({
      ok: true,
    });
  });

  test("accepts a match after harmless terminal repadding", () => {
    expect(
      verifyExpectedPrompt(
        "older output\nApprove this?   \n1. Yes  \n\n2. No ",
        "Approve this?\n1. Yes\n2. No",
      ),
    ).toEqual({ ok: true });
  });

  test("returns not_found after the prompt was answered and replaced", () => {
    expect(verifyExpectedPrompt("Running tests\nAll done", "Approve?\n1. Yes\n2. No")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  test("returns not_in_tail when the region exists only high in scrollback", () => {
    const fresh = [
      "Approve?",
      "1. Yes",
      "2. No",
      ...Array.from({ length: DEFAULT_PROMPT_TAIL_LINES + 1 }, (_, i) => `line ${i}`),
    ].join("\n");
    expect(verifyExpectedPrompt(fresh, "Approve?\n1. Yes\n2. No")).toEqual({
      ok: false,
      reason: "not_in_tail",
    });
  });

  test("refuses a stale region when a full replacement prompt is rendered below it", () => {
    const expected = ["Apply this edit?", "  old value", "  new value", "1. Yes", "2. No"].join("\n");
    const replacement = [
      "Apply this different edit?",
      "  function replacement() {",
      "    const first = true;",
      "    const second = false;",
      "    const third = null;",
      "    return { first, second, third };",
      "  }",
      "",
      "This change affects:",
      "  bridge/server.ts",
      "  bridge/server.test.ts",
      "",
      "Choose an action:",
      "1. Apply",
      "2. Apply and remember",
      "3. Refuse",
      "4. Explain",
      "5. Open details",
      "6. Cancel",
      "7. Retry",
      "8. Show diff",
      "Selection:",
    ].join("\n");

    expect(verifyExpectedPrompt(`${expected}\n${replacement}`, expected)).toEqual({
      ok: false,
      reason: "not_in_tail",
    });
  });

  test("returns empty when expected normalizes to no lines", () => {
    expect(verifyExpectedPrompt("Approve?\n1. Yes", " \r\n\t\n")).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  test("uses the last occurrence when a region appears more than once", () => {
    const gap = Array.from({ length: DEFAULT_PROMPT_TAIL_LINES + 5 }, (_, i) => `output ${i}`);
    const fresh = ["Approve?", "1. Yes", ...gap, "Approve?", "1. Yes"].join("\n");
    expect(verifyExpectedPrompt(fresh, "Approve?\n1. Yes")).toEqual({ ok: true });
  });

  test("requires the expected lines to be contiguous", () => {
    expect(
      verifyExpectedPrompt(
        "Approve?\nunrelated output\n1. Yes\nmore output\n2. No",
        "Approve?\n1. Yes\n2. No",
      ),
    ).toEqual({ ok: false, reason: "not_found" });
  });
});

// ── The client/bridge contract ───────────────────────────────────────────────
//
// The load-bearing risk in this feature is not a wrong comparison, it is a SILENT DIVERGENCE. The
// client derives the region it sends from pane text it has already parsed ANSI away from; the bridge
// verifies that region against the RAW `pane.read`. Nothing in the type system couples the two. If
// either side's normalisation drifts, every legitimate approval starts failing with "prompt changed"
// and the honest-looking symptom is a feature users switch off.
//
// So both sides are pinned to the same committed expectation. `prompt-binding-regions.json` holds,
// for each real pane fixture, the exact region string its detector produces. THIS test proves the
// bridge still finds those regions in the raw fixtures. Its sibling in
// web/src/lib/harness/prompt-binding-contract.test.ts proves the client detectors still produce them
// byte-for-byte. Neither side can drift without one of the two going red.
//
// Regenerating the JSON to make a failure "go away" defeats the point: if the web test is the one
// that fails, the detector changed and the regions may legitimately need regenerating; if THIS test
// fails, the bridge's normalisation stopped matching text the client will really send.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE_DIR = join(import.meta.dir, "..", "web", "src", "fixtures", "panes");
const REGIONS = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "web", "src", "fixtures", "prompt-binding-regions.json"), "utf8"),
) as { fixture: string; detector: string; region: string }[];

describe("client/bridge binding contract", () => {
  test("the committed expectations cover every dialog detector", () => {
    expect(REGIONS.length).toBeGreaterThan(0);
    expect([...new Set(REGIONS.map((r) => r.detector))].sort()).toEqual([
      "multi-select",
      "preview-select",
      "prompt-select",
      "wizard",
    ]);
  });

  for (const { fixture, detector, region } of REGIONS) {
    test(`${detector}: the bridge finds ${fixture}'s region in the raw pane read`, () => {
      const raw = readFileSync(join(FIXTURE_DIR, fixture), "utf8");
      expect(verifyExpectedPrompt(raw, region)).toEqual({ ok: true });
    });
  }

  test("a region from a different dialog is never accepted", () => {
    let compared = 0;
    for (const a of REGIONS) {
      const raw = readFileSync(join(FIXTURE_DIR, a.fixture), "utf8");
      for (const b of REGIONS) {
        if (a.fixture === b.fixture) continue;
        compared++;
        expect(verifyExpectedPrompt(raw, b.region).ok).toBe(false);
      }
    }
    expect(compared).toBeGreaterThan(0);
  });
});

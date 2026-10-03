import { describe, expect, test } from "bun:test";

import {
  DEFAULT_PROMPT_TAIL_LINES,
  normalizePromptRegion,
  verifyExpectedPrompt,
  verifyExpectedStyled,
  verifyPromptBinding,
} from "./prompt-binding.ts";
import {
  decodeStyledRegion,
  encodeStyledRegion,
  STYLED_FORMAT,
  styledRegionLines,
} from "../web/src/lib/styled-region.ts";

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

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE_DIR = join(import.meta.dir, "..", "web", "src", "fixtures", "panes");
/** One committed expectation: which region of which pane fixture a given detector must bind to. */
interface BindingRegion {
  fixture: string;
  detector: string;
  region: string;
}

// SAFETY: the fixture file is committed alongside this test and is regenerated only by it; the
// assertions below check every field of every row.
const REGIONS = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "web", "src", "fixtures", "prompt-binding-regions.json"), "utf8"),
) as BindingRegion[];

describe("client/bridge binding contract", () => {
  test("the committed expectations cover every dialog detector", () => {
    expect(REGIONS.length).toBeGreaterThan(0);
    expect([...new Set(REGIONS.map((r) => r.detector))].toSorted()).toEqual([
      "menu",
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
    const rawCache = new Map<string, string>();
    const rawOf = (fixture: string): string => {
      const hit = rawCache.get(fixture);
      if (hit !== undefined) return hit;
      const text = readFileSync(join(FIXTURE_DIR, fixture), "utf8");
      rawCache.set(fixture, text);
      return text;
    };

    let compared = 0;
    let identicalPairs = 0;
    for (const a of REGIONS) {
      const raw = rawOf(a.fixture);
      for (const b of REGIONS) {
        if (a.fixture === b.fixture) continue;
        // Two fixtures can be the same screen, byte for byte: the /effort slider sits in the corpus
        // twice, once as `claude--menu-effort-slider.txt` and once as the capture-lab original it
        // was copied from. A match between those two is the contract working, not a collision. The
        // exemption is keyed on the RAW FILE BYTES, never on the region text — two different dialogs
        // that declared the same region would be exactly the collision this test exists to catch.
        if (raw === rawOf(b.fixture)) {
          identicalPairs++;
          continue;
        }
        compared++;
        expect(verifyExpectedPrompt(raw, b.region).ok).toBe(false);
      }
    }
    expect(compared).toBeGreaterThan(0);
    // The exemption must not go vacuous: if the duplicate capture ever leaves the corpus, the skip
    // above is dead code and this line says so.
    expect(identicalPairs).toBeGreaterThan(0);
  });
});

// ADR 0080 point 7. The text check strips every SGR escape, so a pointer drawn only as a background
// colour is invisible to it. `expected_styled` is the phone's canonical styled lines of the same rows
// (behind a `v1` format line); the bridge runs the SAME function over the fresh read and compares at
// the index where the text matched.
describe("verifyPromptBinding: the style check", () => {
  const E = "\u001b";
  const TEXT_REGION = "Permission required\n Allow once    Reject";
  /** What the phone sends: the wire value of the canonical lines of the region it saw. */
  const expectedOf = (screen: string): string => encodeStyledRegion(styledRegionLines(screen));
  const chips = (pointer: 0 | 1) =>
    [
      "Permission required",
      `${pointer === 0 ? `${E}[43m` : ""} Allow once ${E}[0m  ${pointer === 1 ? `${E}[43m` : ""} Reject ${E}[0m`,
    ].join("\n");
  const check = (screen: string, styled: string | undefined, text = TEXT_REGION) =>
    verifyPromptBinding(screen, text, styled);

  test("accepts the screen it was derived from", () => {
    expect(check(chips(0), expectedOf(chips(0)))).toEqual({ ok: true, styled: "checked" });
  });

  test("no styled value is the text check alone, and says nothing of style", () => {
    expect(check(chips(1), undefined)).toEqual({ ok: true });
  });

  test("refuses the same text with the style moved, which the text check cannot see", () => {
    expect(verifyExpectedPrompt(chips(1), TEXT_REGION)).toEqual({ ok: true });
    expect(check(chips(1), expectedOf(chips(0)))).toEqual({ ok: false, reason: "style_not_found" });
  });

  test("ignores how the escapes were spelled, trailing padding and blank-line layout", () => {
    const expected = expectedOf(`${E}[1;31mApprove?${E}[0m\n1. Yes`);
    const respelled = `\n${E}[31m${E}[1mApprove?${E}[m   \r\n\r\n${E}[0m1. Yes${E}[44m      ${E}[0m\r\n`;
    expect(check(respelled, expected, "Approve?\n1. Yes")).toEqual({ ok: true, styled: "checked" });
  });

  test("a text change is refused, by the text check first", () => {
    expect(check(chips(0).replace("Reject", "Deny"), expectedOf(chips(0)))).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  test("an empty styled value is refused, never matched against everything", () => {
    expect(check(chips(0), "")).toEqual({ ok: false, reason: "style_empty" });
    expect(check(chips(0), STYLED_FORMAT)).toEqual({ ok: false, reason: "style_empty" });
    expect(check(chips(0), `${STYLED_FORMAT}\n\n`)).toEqual({ ok: false, reason: "style_empty" });
  });

  test("an expectation with fewer styled lines than text lines is refused", () => {
    const oneLine = encodeStyledRegion(styledRegionLines(chips(0)).slice(-1));
    expect(check(chips(0), oneLine)).toEqual({ ok: false, reason: "style_not_found" });
  });

  test("a stale text match above more than the tail's worth of newer lines is refused by the text check", () => {
    const newer = Array.from({ length: DEFAULT_PROMPT_TAIL_LINES + 1 }, (_, i) => `later ${i}`).join("\n");
    expect(check(`${chips(0)}\n${newer}`, expectedOf(chips(0)))).toEqual({ ok: false, reason: "not_in_tail" });
    const within = Array.from({ length: 2 }, (_, i) => `later ${i}`).join("\n");
    expect(check(`${chips(0)}\n${within}`, expectedOf(chips(0)))).toEqual({ ok: true, styled: "checked" });
  });

  test("matches a region that is only the lower rows of the screen", () => {
    const screen = `header\n${chips(1)}`;
    expect(check(screen, expectedOf(chips(1)))).toEqual({ ok: true, styled: "checked" });
  });

  describe("the same place", () => {
    // A stale copy of the region sits above the live one: pointer on Allow once up there (style A),
    // pointer on Reject down here (style B). The text is the same in both copies and the last match is
    // the live one. A style check with a search of its own would find A at the stale copy and accept.
    const buffer = `${chips(0)}\n${chips(1)}`;

    test("expected styled = the stale copy's style is refused", () => {
      expect(verifyExpectedPrompt(buffer, TEXT_REGION)).toEqual({ ok: true });
      expect(check(buffer, expectedOf(chips(0)))).toEqual({ ok: false, reason: "style_not_found" });
    });

    test("expected styled = the live copy's style passes", () => {
      expect(check(buffer, expectedOf(chips(1)))).toEqual({ ok: true, styled: "checked" });
    });
  });

  describe("alignment", () => {
    test("a fresh read whose two projections differ in length is refused as style_misaligned", () => {
      // A line holding only a non-SGR escape: the styled projection drops it, the text one keeps it.
      const odd = `Permission required\n${E}[2K\n Allow once    Reject`;
      expect(normalizePromptRegion(odd).length).not.toBe(styledRegionLines(odd).length);
      expect(check(odd, expectedOf(chips(0)), "Permission required")).toEqual({
        ok: false,
        reason: "style_misaligned",
      });
    });

    test("every committed pane fixture has aligned text and styled projections", () => {
      const names = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".txt"));
      expect(names.length).toBeGreaterThan(100);
      const misaligned = names.filter((name) => {
        const raw = readFileSync(join(FIXTURE_DIR, name), "utf8");
        return normalizePromptRegion(raw).length !== styledRegionLines(raw).length;
      });
      expect(misaligned).toEqual([]);
    });
  });

  describe("the format line", () => {
    test("encode and decode round trip, and the wire value starts with v1", () => {
      const lines = styledRegionLines(chips(0));
      const wire = encodeStyledRegion(lines);
      expect(wire.startsWith("v1\n")).toBe(true);
      expect(decodeStyledRegion(wire)).toEqual({ version: "v1", lines });
      expect(decodeStyledRegion("")).toBeNull();
    });

    test("a value of an unknown version is skipped, not refused: the text check decides, and it is recorded", () => {
      const future = `v2\n${styledRegionLines(chips(0)).join("\n")}`;
      // The highlight moved, which a v1 check would refuse. The unknown version is not judged.
      expect(check(chips(1), future)).toEqual({ ok: true, styled: "skipped_unknown_version" });
    });

    test("a value with no format line at all (a run line first) is an unknown version too", () => {
      expect(check(chips(1), styledRegionLines(chips(0)).join("\n"))).toEqual({
        ok: true,
        styled: "skipped_unknown_version",
      });
    });

    test("an unknown version does not excuse a text mismatch", () => {
      expect(check("Command finished", "v2\nwhatever")).toEqual({ ok: false, reason: "not_found" });
    });

    test("the version must be exactly v1", () => {
      for (const first of ["V1", "v1 ", "v10", "v1\r"]) {
        expect(check(chips(1), `${first}\n${styledRegionLines(chips(0)).join("\n")}`)).toEqual({
          ok: true,
          styled: "skipped_unknown_version",
        });
      }
    });
  });

  describe("verifyExpectedStyled, the strict form", () => {
    test("is ok only when the style was actually checked", () => {
      expect(verifyExpectedStyled(chips(0), TEXT_REGION, expectedOf(chips(0)))).toEqual({ ok: true });
      expect(verifyExpectedStyled(chips(1), TEXT_REGION, expectedOf(chips(0)))).toEqual({
        ok: false,
        reason: "style_not_found",
      });
      expect(verifyExpectedStyled(chips(1), TEXT_REGION, "v2\nx")).toEqual({
        ok: false,
        reason: "style_unchecked",
      });
    });
  });
});

describe("expected_styled against the real opencode captures", () => {
  const read = (name: string) => readFileSync(join(FIXTURE_DIR, name), "utf8");
  const once = read("oc--permission-bash.txt");
  const always = read("oc--permission-bash--moved.txt");

  test("the two captures have the same TEXT, so the text check passes both ways, and only the colours tell them apart", () => {
    // The dialog's last rows as text: what the phone's `signature` is made of.
    const region = normalizePromptRegion(once).slice(-6).join("\n");
    expect(verifyExpectedPrompt(once, region)).toEqual({ ok: true });
    expect(verifyExpectedPrompt(always, region)).toEqual({ ok: true });

    const styled = encodeStyledRegion(styledRegionLines(once).slice(-6));
    expect(verifyExpectedStyled(once, region, styled)).toEqual({ ok: true });
    expect(verifyExpectedStyled(always, region, styled).ok).toBe(false);
  });
});

// A pane is hostile input: whatever it prints reaches `styledRegionLines` and the combined verifier
// before anything is checked. None of these may throw or take long.
describe("hostile pane content", () => {
  const E = "\u001b";
  const BOUND_MS = 2000;
  const cases: [string, () => string][] = [
    ["a single 1 MB line of plain text", () => "x".repeat(1_000_000)],
    [
      "200 KB of SGR parameter runs",
      () => `${E}[${"38;5;1;38;5;2;".repeat(Math.ceil(200_000 / 14))}mX`,
    ],
    ["unterminated CSI sequences repeated 100k times", () => `${E}[`.repeat(100_000)],
    [
      "10,000 lines of 20 colour changes each",
      () =>
        Array.from(
          { length: 10_000 },
          () => Array.from({ length: 20 }, (_, i) => `${E}[3${i % 8}mab`).join("") + `${E}[0m`,
        ).join("\n"),
    ],
  ];

  for (const [name, build] of cases) {
    test(`${name}: styledRegionLines and the combined verifier finish in time and do not throw`, () => {
      const raw = build();
      const started = performance.now();
      const lines = styledRegionLines(raw);
      const styled = encodeStyledRegion(lines.slice(-3));
      const verdict = verifyPromptBinding(raw, "x\nab", styled);
      const elapsed = performance.now() - started;
      expect(lines).toBeInstanceOf(Array);
      expect([true, false]).toContain(verdict.ok);
      expect(elapsed).toBeLessThan(BOUND_MS);
    });
  }
});

import { describe, expect, test } from "bun:test";

import {
  composerBelowShadow,
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
import { cropRawColumns, type ColumnRange } from "../web/src/lib/column-range.ts";
import { parseAnsi } from "../web/src/lib/ansi.ts";
import { splitLines } from "../web/src/lib/blocks.ts";
import { findInputFrame } from "../web/src/lib/surface/frame.ts";
import { requireProfile } from "../web/src/lib/surface/profile.ts";
import { detectQuestion as detectMuseQuestion } from "../web/src/lib/harness/muse/question.ts";
import { detectCheckbox as detectMuseCheckbox } from "../web/src/lib/harness/muse/checkbox.ts";

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
/** One committed expectation: which region of which pane fixture a given detector must bind to, and,
 *  for a region read from part of each row, the columns the bridge cuts its read to first. */
interface BindingRegion {
  fixture: string;
  detector: string;
  region: string;
  bindColumns?: ColumnRange;
}

// SAFETY: the fixture file is committed alongside this test and is regenerated only by it; the
// assertions below check every field of every row.
const REGIONS = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "web", "src", "fixtures", "prompt-binding-regions.json"), "utf8"),
) as BindingRegion[];

/** Fixtures that show ONE dialog and so legitimately share a region: the `-named-` captures of Claude
 *  Code 2.1.296 beside their unnamed twins, the wizard review step at both widths, and the `/effort`
 *  slider on `high` at 120 columns captured twice. That last pair differed only in the label spliced
 *  into the `▔` edge, which the menu's region leaves out since 1.22.5 (Claude puts timed notices
 *  there). */
const SAME_DIALOG: string[][] = [
  ["claude--menu-effort-slider--w120.txt", "claude--v2283-slash-effort.txt"],
  ["claude-lab--ask-multi-named-v2296--w82.txt", "claude-lab--ask-multi-v2296--w82.txt"],
  ["claude-lab--ask-multi-named-v2296--w40.txt", "claude-lab--ask-multi-v2296--w40.txt"],
  ["claude-lab--ask-single-named-v2296--w40.txt", "claude-lab--ask-single-v2296--w40.txt"],
  ["claude-lab--ask-wizard-named-v2296--w82.txt", "claude-lab--ask-wizard-v2296--w82.txt"],
  [
    "claude-lab--ask-wizard-review-named-v2296--w82.txt",
    "claude-lab--ask-wizard-review-named-v2296--w40.txt",
    "claude-lab--ask-wizard-review-v2296--w82.txt",
    "claude-lab--ask-wizard-review-v2296--w40.txt",
  ],
  ["claude-lab--menu-config-panel-named-v2296--w40.txt", "claude-lab--menu-config-panel-v2296--w40.txt"],
];

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

  for (const { fixture, detector, region, bindColumns } of REGIONS) {
    test(`${detector}: the bridge finds ${fixture}'s region in the raw pane read`, () => {
      const raw = readFileSync(join(FIXTURE_DIR, fixture), "utf8");
      expect(verifyPromptBinding(raw, region, undefined, bindColumns)).toEqual({ ok: true });
      if (bindColumns === undefined) expect(verifyExpectedPrompt(raw, region)).toEqual({ ok: true });
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
    let sameDialogPairs = 0;
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
        // The same dialog captured twice, with different bytes around it: a session named with
        // `/rename` and an unnamed one draw the same dialog (Claude Code 2.1.296 adds a closing
        // rule under it in the named one), and the wizard's review step reads the same at 40 and 82
        // columns. The exemption is a NAMED list, not a comparison of region text, and a group is
        // only legitimate while its members really hold one region, as the bridge reads a region:
        // normalized, so a capture with trailing spaces on its blank rows is still the same one.
        if (SAME_DIALOG.some((group) => group.includes(a.fixture) && group.includes(b.fixture))) {
          expect(normalizePromptRegion(b.region), `${a.fixture} and ${b.fixture} are listed as one dialog`).toEqual(normalizePromptRegion(a.region));
          sameDialogPairs++;
          continue;
        }
        compared++;
        expect(verifyPromptBinding(raw, b.region, undefined, b.bindColumns).ok).toBe(false);
      }
    }
    expect(compared).toBeGreaterThan(0);
    // The exemption must not go vacuous: if the duplicate capture ever leaves the corpus, the skip
    // above is dead code and this line says so.
    expect(identicalPairs).toBeGreaterThan(0);
    expect(sameDialogPairs).toBeGreaterThan(0);
  });
});

// Claude Code 2.1.299 draws its task checklist under a dialog's footer, and a list of five rows or
// more pushes the region out of the tail window. A trailing checklist whose counts agree with its
// header is not counted against the tail (web/src/lib/task-checklist.ts); anything else still is.
describe("a task checklist under the region", () => {
  const LONG = "claude--v2299-ask-under-long-task-list.txt";
  const raw = readFileSync(join(FIXTURE_DIR, LONG), "utf8");
  const { region } = REGIONS.find((r) => r.fixture === LONG)!;
  const regionLines = normalizePromptRegion(region);
  /** Seven rows under the region, each `rows(i)`, so the region ends outside the six-row tail. */
  const under = (header: string, row: (i: number) => string): string =>
    [region, header, ...Array.from({ length: 6 }, (_, i) => row(i))].join("\n");

  test("the phone's region binds on the screen with the long list under it", () => {
    expect(verifyPromptBinding(raw, region)).toEqual({ ok: true });
    expect(verifyExpectedPrompt(raw, region)).toEqual({ ok: true });
  });

  test("the style check runs at the same place and passes", () => {
    const freshLines = normalizePromptRegion(raw);
    const start = freshLines.findIndex((_, i) => regionLines.every((line, k) => freshLines[i + k] === line));
    const styled = encodeStyledRegion(styledRegionLines(raw).slice(start, start + regionLines.length));
    expect(verifyPromptBinding(raw, region, styled)).toEqual({ ok: true, styled: "checked" });
  });

  test("a list whose counts agree is skipped wherever it sits under the region", () => {
    expect(verifyExpectedPrompt(under("  6 tasks (0 done, 6 open)", (i) => `  ◻ Step ${i}`), region)).toEqual({ ok: true });
  });

  test("seven rows of other output under the region still push it out of the tail", () => {
    expect(verifyExpectedPrompt(under("output row", (i) => `output row ${i}`), region)).toEqual({
      ok: false,
      reason: "not_in_tail",
    });
  });

  test("a list whose counts do not add up is counted against the tail", () => {
    expect(verifyExpectedPrompt(under("  6 tasks (1 done, 5 open)", (i) => `  ◻ Step ${i}`), region)).toEqual({
      ok: false,
      reason: "not_in_tail",
    });
    expect(verifyExpectedPrompt(under("  7 tasks (0 done, 6 open)", (i) => `  ◻ Step ${i}`), region)).toEqual({
      ok: false,
      reason: "not_in_tail",
    });
  });
});

// M56 spec 03, SHADOW MODE. The idea: a dialog replaces the composer while it is up, so an input box
// drawn UNDER the matched region would mean the dialog has closed. The premise is false for Muse, which
// draws a live question above its own Claude-shaped box. So the frame module's answer is recorded in
// the audit line (`composerBelowShadow`) and never refuses: `verifyPromptBinding` does not look at it.
describe("an input box under the region (shadow only)", () => {
  const FIXTURE = "claude--permission-bash.txt";
  const { region } = REGIONS.find((r) => r.fixture === FIXTURE)!;
  const RULE = "─".repeat(40);

  test("the live dialog binds and the shadow says nothing", () => {
    const raw = readFileSync(join(FIXTURE_DIR, FIXTURE), "utf8");
    expect(verifyPromptBinding(raw, region)).toEqual({ ok: true });
    expect(composerBelowShadow(raw, region)).toBeUndefined();
  });

  test("the same region with the composer back under it binds, and the shadow records it", () => {
    const fresh = [region, "", RULE, "❯\u00a0", RULE, "  ? for shortcuts"].join("\n");
    expect(verifyPromptBinding(fresh, region)).toEqual({ ok: true });
    expect(verifyExpectedPrompt(fresh, region)).toEqual({ ok: true });
    expect(composerBelowShadow(fresh, region)).toBe("composer_below");
  });

  test("a draft in that box changes nothing", () => {
    const fresh = [region, RULE, "❯ yes please", RULE].join("\n");
    expect(verifyPromptBinding(fresh, region)).toEqual({ ok: true });
    expect(composerBelowShadow(fresh, region)).toBe("composer_below");
  });

  test("an echoed box ABOVE the live region is not the composer", () => {
    const fresh = [RULE, "❯ an old prompt", RULE, region].join("\n");
    expect(composerBelowShadow(fresh, region)).toBeUndefined();
  });

  test("a half box under the region (no bottom edge) is no frame", () => {
    const fresh = [region, RULE, "❯ "].join("\n");
    expect(composerBelowShadow(fresh, region)).toBeUndefined();
  });

  test("a region the text check refuses gives no shadow", () => {
    const fresh = [RULE, "❯ ", RULE].join("\n");
    expect(verifyPromptBinding(fresh, region).ok).toBe(false);
    expect(composerBelowShadow(fresh, region)).toBeUndefined();
  });
});

// The case that kept composer_below out of the verdict: every live Muse question draws Claude's own
// input box under the question, and a tap on it must bind.
describe("a live Muse question binds with the input box under it", () => {
  const MUSE_ASKS = [
    "muse--ask-color.txt",
    "muse--ask-color-moved.txt",
    "muse--ask-season.txt",
    "muse--ask-multi-q1.txt",
    "muse--ask-multi-q2.txt",
    "muse--ask-multi-review.txt",
    "muse--ask-drinks.txt",
    "muse--ask-toppings.txt",
    "muse--ask-toppings-147.txt",
    "muse--ask-toppings-147-moved.txt",
    "muse--ask-toppings-checked.txt",
    "muse--ask-toppings-review.txt",
  ];

  for (const fixture of MUSE_ASKS) {
    test(fixture, () => {
      const raw = readFileSync(join(FIXTURE_DIR, fixture), "utf8");
      const lines = splitLines(parseAnsi(raw));
      const region = detectMuseQuestion(lines)?.signature ?? detectMuseCheckbox(lines)?.regionSignature;
      expect(region).toBeDefined();
      expect(verifyPromptBinding(raw, region!)).toEqual({ ok: true });
      expect(verifyExpectedPrompt(raw, region!)).toEqual({ ok: true });
      // The shadow sees the box and says so; that is exactly why it is not a refusal.
      expect(composerBelowShadow(raw, region!)).toBe("composer_below");
    });
  }
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

// A region read from a column range of its rows (`expected_columns`, web/src/lib/column-range.ts).
// Oh My Pi's side panel runs beside a question and ticks; the phone reads the question from the
// columns left of the panel, and the bridge cuts every row of its read to the same columns.
describe("bindColumns: the bridge compares only the bound columns", () => {
  const FIXTURE = "pi--omo-v5130-panel-question.txt";
  const raw = readFileSync(join(FIXTURE_DIR, FIXTURE), "utf8");
  const row = REGIONS.find((r) => r.fixture === FIXTURE)!;
  const columns = row.bindColumns!;
  const check = (screen: string, range: ColumnRange | undefined) =>
    verifyPromptBinding(screen, row.region, undefined, range);

  test("the panel question is pinned with its columns, 0 to the panel's 91", () => {
    expect(columns).toEqual({ start: 0, end: 91 });
    expect(check(raw, columns)).toEqual({ ok: true });
  });

  test("a change beside the region (the panel ticks) does not refuse the tap", () => {
    for (const [from, to] of [
      ["5 queued", "6 queued"],
      ["23.9K/200K", "24.1K/200K"],
      ["work-00392473", "work-00392474"],
    ] as const) {
      const ticked = raw.replace(from, to);
      expect(ticked, from).not.toBe(raw);
      expect(check(ticked, columns), from).toEqual({ ok: true });
    }
  });

  test("a change inside the region refuses it", () => {
    for (const [from, to] of [
      ["Pick a color?", "Pick a colour"],
      ["· 30m", "· 29m"],
      ["Green", "Blue!"],
    ] as const) {
      const moved = raw.replace(from, to);
      expect(moved, from).not.toBe(raw);
      expect(check(moved, columns), from).toEqual({ ok: false, reason: "not_found" });
    }
  });

  test("without the range the region is compared as whole rows and refused: absent fails closed", () => {
    expect(check(raw, undefined)).toEqual({ ok: false, reason: "not_found" });
    expect(verifyExpectedPrompt(raw, row.region)).toEqual({ ok: false, reason: "not_found" });
  });

  test("another range is another binding: one column short or long is refused", () => {
    expect(check(raw, { start: 0, end: 90 }).ok).toBe(false);
    expect(check(raw, { start: 0, end: 92 }).ok).toBe(false);
  });
});

describe("cropRawColumns", () => {
  const E = "\u001b";

  test("cuts each row at display columns and keeps every escape, so the style check sees the kept cells", () => {
    const screen = `${E}[31mab${E}[0m${E}[32mcdef${E}[0m\nxyz`;
    expect(cropRawColumns(screen, { start: 0, end: 4 })).toBe(`${E}[31mab${E}[0m${E}[32mcd${E}[0m\nxyz`);
    expect(normalizePromptRegion(cropRawColumns(screen, { start: 1, end: 3 }))).toEqual(["bc", "yz"]);
    const styled = styledRegionLines(cropRawColumns(screen, { start: 0, end: 4 }));
    expect(styled).toEqual(styledRegionLines(`${E}[31mab${E}[0m${E}[32mcd${E}[0m\nxyz`));
  });

  test("a wide glyph counts two columns and is dropped whole when it crosses an edge", () => {
    expect(cropRawColumns("中文ab", { start: 0, end: 4 })).toBe("中文");
    expect(cropRawColumns("中文ab", { start: 0, end: 3 })).toBe("中");
    expect(cropRawColumns("中文ab", { start: 1, end: 6 })).toBe("文ab");
  });

  test("keeps rows as rows, CRLF included, and leaves a short row whole", () => {
    expect(cropRawColumns("one\r\ntwo", { start: 0, end: 2 })).toBe("on\r\ntw");
    expect(cropRawColumns("short", { start: 0, end: 40 })).toBe("short");
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

// The card of Claude Code's notice above a live box (ADR 0109) binds from the notice's head down
// through the box's bottom edge, so the bridge's own read refuses a tap once the box holds a draft: a
// digit typed then would join the draft (review F4). The status rows under the box stay inside the
// tail window with up to five of them (review F5).
describe("a notice card above a live box", () => {
  const NOTICE = "claude--v2302-heads-up-above-box--w142.txt";
  const region = REGIONS.find((row) => row.fixture === NOTICE)!.region;
  const raw = readFileSync(join(FIXTURE_DIR, NOTICE), "utf8");
  const statusRow = raw.split(/\r?\n/u).at(-2)!;

  test("binds on the empty box, with one and with three extra status rows under it", () => {
    expect(verifyPromptBinding(raw, region)).toEqual({ ok: true });
    for (const extra of [1, 3]) {
      const taller = [raw, ...Array.from({ length: extra }, () => statusRow)].join("\n");
      expect(verifyPromptBinding(taller, region), `${String(extra)} extra`).toEqual({ ok: true });
    }
  });

  test("refuses the tap once a draft stands in the box", () => {
    const drafted = raw.replace("❯ ", "❯ half a thought");
    expect(drafted).not.toBe(raw);
    expect(verifyPromptBinding(drafted, region).ok).toBe(false);
  });

  test("refuses the region with six plain status rows more under the box", () => {
    const taller = [raw, ...Array.from({ length: 6 }, () => statusRow)].join("\n");
    expect(verifyPromptBinding(taller, region)).toEqual({ ok: false, reason: "not_in_tail" });
  });

  // Claude Code's agents panel, listing three background agents under the statusline, is the footer
  // run the input frame names: it is not counted against the tail.
  test("binds with the agents panel under the box", () => {
    const panel = readFileSync(join(FIXTURE_DIR, "claude--v2302-notice-over-agents-panel--w69.txt"), "utf8");
    const rows = panel.split(/\r?\n/u);
    expect(rows[59]).toContain("You should know · ");
    expect(rows[66]).toMatch(/^\S*─+/u);
    expect(verifyPromptBinding(panel, rows.slice(59, 67).join("\n"))).toEqual({ ok: true });
  });

  // A Claude frame left on screen with plain output under it, a blank row between (a shell under a
  // Claude that has exited): the frame walk takes those rows for a generic footer, which is no named
  // run, so nothing is cut and a stale digit tap is refused.
  test("refuses the region with a blank row and four to eight plain output rows under the box", () => {
    for (let count = 4; count <= 8; count++) {
      const output = Array.from({ length: count }, (_, i) => `notes-${String(i)}.txt`);
      expect(verifyPromptBinding([raw, "", ...output].join("\n"), region), `${String(count)} rows`).toEqual({
        ok: false,
        reason: "not_in_tail",
      });
    }
  });
});

// The read is cut only at the footer run a profile names under its input box (ADR 0109): Claude
// Code's agents panel, whose rows claude.json lists (`idle.volatile.below.footerRows`). The cut may
// turn a `not_in_tail` refusal into a binding, and changes no other verdict.
describe("the cut at the agents panel", () => {
  const PANEL = "claude--v2302-notice-over-agents-panel--w69.txt";
  const rows = readFileSync(join(FIXTURE_DIR, PANEL), "utf8").split(/\r?\n/u);
  const region = rows.slice(59, 67).join("\n");
  const namedRows = (read: string): number =>
    findInputFrame(splitLines(parseAnsi(read)), requireProfile("claude").idle)?.volatile.named.length ?? 0;
  /** The capture with `extra` more status rows over the blank row that sets the panel apart. */
  const withStatusRows = (extra: number): string =>
    [...rows.slice(0, 69), ...Array.from({ length: extra }, () => rows[67]!), ...rows.slice(69)].join("\n");

  test("counts the rows between the box and the panel: five bind, six or more refuse", () => {
    expect(verifyPromptBinding(withStatusRows(3), region)).toEqual({ ok: true });
    for (const extra of [4, 6]) {
      const read = withStatusRows(extra);
      expect(namedRows(read), `${String(extra)} extra: the panel is named, so the cut runs`).toBe(4);
      expect(verifyPromptBinding(read, region), `${String(extra)} extra`).toEqual({ ok: false, reason: "not_in_tail" });
    }
  });

  // A region inside the run: the read cut above the run no longer holds it (`not_found`), and the
  // uncut refusal stands, as it did for agy--slash-exact.txt's region inside its slash popup when a
  // generic footer was cut.
  test("keeps the uncut refusal when the cut leaves the region out", () => {
    const agent = rows[71]!;
    const read = [...rows.slice(0, 74), agent, agent, agent].join("\n");
    expect(namedRows(read)).toBe(7);
    expect(verifyPromptBinding(read, rows[70]!)).toEqual({ ok: false, reason: "not_in_tail" });
  });

  // agy.json names no footer rows, so its frame names no run and nothing is cut: its slash popup's
  // region binds where it stands, and output pushing it out of the tail refuses it.
  test("cuts nothing on agy--slash-exact.txt", () => {
    const AGY = "agy--slash-exact.txt";
    const raw = readFileSync(join(FIXTURE_DIR, AGY), "utf8");
    const { region: popup } = REGIONS.find((row) => row.fixture === AGY)!;
    expect(findInputFrame(splitLines(parseAnsi(raw)), requireProfile("agy").idle)?.volatile.named).toEqual([]);
    expect(verifyPromptBinding(raw, popup)).toEqual({ ok: true });
    const pushed = [raw.trimEnd(), ...Array.from({ length: 6 }, (_, i) => `output row ${String(i)}`)].join("\n");
    expect(verifyPromptBinding(pushed, popup)).toEqual({ ok: false, reason: "not_in_tail" });
  });
});

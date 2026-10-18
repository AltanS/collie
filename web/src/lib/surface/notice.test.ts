import { describe, expect, it } from "vitest";

import { fixtureRows } from "../../test/surface-corpus";
import { findInputFrame, plainRows, rowText } from "./frame";
import { readAboveNotice } from "./notice";
import { requireProfile } from "./profile";

// The notice a harness draws above its live box: a head row the profile names, up to three indented
// continuation rows, one row of `<digit>: <label>` keys, then only blank rows down to the box.

const IDLE = requireProfile("claude").idle;
const NOTICES = IDLE.notices ?? [];
const GAPS = IDLE.noticeGaps ?? [];
const RULE = "─".repeat(60);
const HEAD = "✦ Heads up · With GitHub triggers, anyone who files an issue can put text in front of a session";
const KEYS = "  1: Learn more   2: Knew this already   0: Dismiss";
const USAGE = "  You've used 87% of your weekly limit · resets Oct 22, 1am (Ameri…";

/**
 * Claude Code 2.1.302 at 69 columns, seen live on 2026-10-17: the usage row it draws for about ten
 * seconds after a turn, in the blank row between the notice's key row and the box's top edge.
 */
const SEEN_RULE = "─".repeat(69);
const SEEN = [
  `──── Sautéed for 5s ${"─".repeat(48)}…`,
  `${" ".repeat(65)}[-]`,
  "✦ Heads up · One of the notes says a nightly cleanup task",
  "  deletes everything on your X: drive at 03:00. All your repos",
  "  live on that drive.",
  "  1: Learn more   2: Knew this already   0: Dismiss",
  USAGE,
  SEEN_RULE,
  "❯",
  SEEN_RULE,
  "  ctx:   9%  |  sub: 5h  49% (3h06m) · 7d  87% / F   1% (4d13h)  |…",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents",
];

/** The notice over the box in these rows, read the way the Surface reads it. */
function noticeOf(rows: ReturnType<typeof plainRows>) {
  const frame = findInputFrame(rows, IDLE);
  expect(frame).not.toBeNull();
  return readAboveNotice(rows.map(rowText), frame!.top, NOTICES, GAPS);
}

function screen(over: readonly string[]): ReturnType<typeof plainRows> {
  return plainRows(["● done", "", ...over, RULE, "❯ ", RULE, "  model · ctx 3%"]);
}

describe("readAboveNotice", () => {
  it("the profile names the head of the notice", () => {
    expect(NOTICES.length).toBeGreaterThan(0);
  });

  it("reads the captured notice: its text and its three printed keys", () => {
    const notice = noticeOf(fixtureRows("claude--v2302-heads-up-above-box--w142.txt"));
    expect(notice).not.toBeNull();
    expect(notice!.text).toBe(
      "Heads up · With GitHub triggers, anyone who files an issue on your public repos can put text in front of an unattended Claude session on your main PC.",
    );
    expect(notice!.keys).toEqual([
      { key: "1", label: "Learn more" },
      { key: "2", label: "Knew this already" },
      { key: "0", label: "Dismiss" },
    ]);
    expect(notice!.last - notice!.first).toBe(2);
  });

  it("reads the other tag word and a notice with no continuation row", () => {
    const notice = noticeOf(screen(["✦ You should know · Something new", KEYS, ""]));
    expect(notice?.text).toBe("You should know · Something new");
    expect(notice?.keys.map((k) => k.key)).toEqual(["1", "2", "0"]);
  });

  it("reads three continuation rows", () => {
    expect(noticeOf(screen([HEAD, "  one", "  two", "  three", KEYS]))?.text).toBe(`${HEAD.slice(2)} one two three`);
  });

  const failClosed: [string, string[]][] = [
    ["no head row", ["  on your main PC.", KEYS, ""]],
    ["a head the profile does not name", ["● How is this going? (optional)", KEYS, ""]],
    ["an item that is not <digit>: label", [HEAD, "  1: Learn more   y: Yes   0: Dismiss"]],
    ["a key row of letters", [HEAD, "  a: Learn more   b: Knew this already"]],
    ["a non-blank row between the keys and the box", [HEAD, KEYS, "  something else"]],
    ["four continuation rows", [HEAD, "  one", "  two", "  three", "  four", KEYS]],
    ["a continuation indented deeper than two", [HEAD, "    deeper", KEYS]],
    ["no key row", [HEAD, "  on your main PC.", ""]],
    // Items a separator glyph joins are split as the single-key cue splits them, so a letter key there shows.
    ["a letter key joined by ·", [HEAD, "  1: Learn more · y: Yes   0: Dismiss"]],
    ["a letter key joined by •", [HEAD, "  1: Learn more • y: Yes   0: Dismiss"]],
    ["a letter key joined by │", [HEAD, "  1: Learn more │ y: Yes   0: Dismiss"]],
    ["a label that holds another key", [HEAD, "  1: Learn more 2: Knew this   0: Dismiss"]],
  ];
  for (const [name, over] of failClosed) {
    it(`fails closed on ${name}`, () => {
      expect(noticeOf(screen(over))).toBeNull();
    });
  }

  it("reads every key of a row whose items a separator glyph joins", () => {
    for (const joined of ["  1: Learn more | 2: Knew this   0: Dismiss", "  1: Learn more • 2: Knew this │ 0: Dismiss"]) {
      expect(noticeOf(screen([HEAD, joined]))?.keys.map((k) => k.key), joined).toEqual(["1", "2", "0"]);
    }
  });

  it("reads a head drawn with nothing after its separator", () => {
    expect(noticeOf(screen(["✦ Heads up ·", "  on your main PC.", KEYS]))?.text).toBe("Heads up · on your main PC.");
  });

  it("does not read the rating survey over the box", () => {
    expect(noticeOf(fixtureRows("claude-lab--survey-rating-above-box--w82.txt"))).toBeNull();
  });

  it("reads nothing with no notice shapes", () => {
    const rows = fixtureRows("claude--v2302-heads-up-above-box--w142.txt");
    expect(readAboveNotice(rows.map(rowText), findInputFrame(rows, IDLE)!.top, [], GAPS)).toBeNull();
  });
});

describe("a row the profile names between the notice and the box (idle.noticeGaps)", () => {
  it("reads the seen screen's notice over the usage row, its end the row above the box", () => {
    const rows = plainRows(SEEN);
    const notice = noticeOf(rows);
    expect(notice?.keys.map((k) => k.key)).toEqual(["1", "2", "0"]);
    expect(notice?.first).toBe(2);
    expect(notice?.last).toBe(5);
    expect(notice?.end).toBe(findInputFrame(rows, IDLE)!.top - 1);
    expect(notice?.end).toBe(6);
  });

  it("reads null for a gap row with no notice above it", () => {
    expect(noticeOf(screen([USAGE]))).toBeNull();
  });

  it("reads null for a row in the gap that no gap pattern names", () => {
    expect(noticeOf(screen([HEAD, KEYS, "  You've used most of your weekly limit"]))).toBeNull();
  });

  const gapMatches = (line: string): boolean => GAPS.some((gap) => new RegExp(gap, "u").test(line));
  for (const line of [USAGE, "  You've used 100% of your weekly limit", "  You've used 5% of your 5-hour limit · resets 3pm"]) {
    it(`the claude profile's gap matches ${JSON.stringify(line)}`, () => {
      expect(gapMatches(line)).toBe(true);
    });
  }
  for (const line of [
    "You've used 87% of your weekly limit",
    "  ❯ You've used 87% of your weekly limit",
    "  1: Learn more   2: Knew this already   0: Dismiss",
    "  You've used most of your weekly limit",
  ]) {
    it(`the claude profile's gap does not match ${JSON.stringify(line)}`, () => {
      expect(gapMatches(line)).toBe(false);
    });
  }
});

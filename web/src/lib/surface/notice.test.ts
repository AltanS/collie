import { describe, expect, it } from "vitest";

import { fixtureRows } from "../../test/surface-corpus";
import { findInputFrame, plainRows, rowText } from "./frame";
import { readAboveNotice } from "./notice";
import { requireProfile } from "./profile";

// The notice a harness draws above its live box: a head row the profile names, up to three indented
// continuation rows, a block of `<digit>: <label>` keys (`<letter>: <label>` under a `letters` head), then
// only blank rows down to the box.

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

  // Decided 2026-10-19 (ADR 0109, after every send on lane 8788 was refused under it): the rating survey
  // is a notice the profile names. This case read null until then.
  it("reads the rating survey over the box as a notice, with its four printed keys", () => {
    for (const name of ["claude-lab--survey-rating-above-box--w82.txt", "claude--v2303-titled-edge-survey--w160.txt"]) {
      const notice = noticeOf(fixtureRows(name));
      expect(notice?.text, name).toBe("How is Claude doing this session? (optional)");
      expect(notice?.keys, name).toEqual([
        { key: "1", label: "Bad" },
        { key: "2", label: "Fine" },
        { key: "3", label: "Good" },
        { key: "0", label: "Dismiss" },
      ]);
    }
  });

  // The update row's wordings: 2.1.303, 2.1.306, and 2.1.314 where it offers the `/restart` command
  // (2026-10-31: under the survey, every send went manual again until the gap took it).
  const UPDATE_WORDINGS = ["Restart to update", "Restart to apply", "/restart to apply"];
  const SURVEY = ["● How is Claude doing this session? (optional)", "  1: Bad    2: Fine   3: Good   0: Dismiss"];

  it("reads the survey over the update row, and the same with a blank row between them", () => {
    for (const wording of UPDATE_WORDINGS) {
      const update = `${" ".repeat(20)}✔ Update installed · ${wording}`;
      for (const between of [[update], ["", update], [update, ""]]) {
        const notice = noticeOf(screen([...SURVEY, ...between]));
        expect(notice?.keys.map((k) => k.key), JSON.stringify(between)).toEqual(["1", "2", "3", "0"]);
      }
    }
  });

  // 2026-10-21, Claude Code 2.1.306: the survey's second question prints letter keys, under a head the
  // profile marks `letters`. Every phone send was refused under it until then.
  const TRANSCRIPT = [
    "● Can Anthropic look at your session transcript to help us improve Claude Code?",
    "  Learn more: https://code.claude.com/docs/en/data-usage#session-quality-surveys",
  ];
  const LETTER_KEYS = "  y: Yes    n: No     d: Don't ask again";

  it("reads the transcript question's capture with its three printed letter keys", () => {
    const notice = noticeOf(fixtureRows("claude--v2306-transcript-survey--w153.txt"));
    expect(notice?.text).toBe(
      "Can Anthropic look at your session transcript to help us improve Claude Code? Learn more: https://code.claude.com/docs/en/data-usage#session-quality-surveys",
    );
    expect(notice?.keys).toEqual([
      { key: "y", label: "Yes" },
      { key: "n", label: "No" },
      { key: "d", label: "Don't ask again" },
    ]);
  });

  it("reads the transcript question over the update row of each wording", () => {
    for (const wording of UPDATE_WORDINGS) {
      const update = `${" ".repeat(20)}✔ Update installed · ${wording}`;
      expect(noticeOf(screen([...TRANSCRIPT, LETTER_KEYS, update]))?.keys.map((k) => k.key), wording).toEqual(["y", "n", "d"]);
    }
  });

  // 2026-11-02, Claude Code 2.1.316: once the context is past 100k tokens and the session has sat idle
  // for 75 minutes, it draws `new task? /clear to save <n> tokens` on the update row's line, alone when no
  // update is installed and ahead of the update item when one is, and keeps it there. Under the survey every
  // send went manual again, and the phone showed no card.
  // Only `292.5k` was seen live; `950` and `1.2m` follow the bundle's formatter (Intl compact, lowercased).
  const IDLE_HINT_ROWS = [
    "new task? /clear to save 292.5k tokens",
    "new task? /clear to save 292.5k tokens · ✔ Update installed · /restart to apply",
    "new task? /clear to save 950 tokens · ✔ Update installed · Restart to update",
    "new task? /clear to save 1.2m tokens · ✔ Update installed · Restart to apply",
  ];

  it("reads the survey and the transcript question under the idle /clear hint, alone or ahead of the update item", () => {
    for (const hint of IDLE_HINT_ROWS) {
      const row = `${" ".repeat(20)}${hint}`;
      expect(noticeOf(screen([...SURVEY, row]))?.keys.map((k) => k.key), hint).toEqual(["1", "2", "3", "0"]);
      expect(noticeOf(screen([...TRANSCRIPT, LETTER_KEYS, row]))?.keys.map((k) => k.key), hint).toEqual(["y", "n", "d"]);
    }
  });

  it("does not skip a row that only looks like the idle /clear hint", () => {
    for (const hint of ["new task? /clear to save tokens", "new task? /clear to save 12k tokens · run the build", "● new task? /clear to save 12k tokens"]) {
      expect(noticeOf(screen([...SURVEY, `${" ".repeat(20)}${hint}`])), hint).toBeNull();
    }
  });

  it("reads letter keys only under a `letters` head, and digits under it never", () => {
    expect(noticeOf(screen(["● How is Claude doing this session? (optional)", LETTER_KEYS]))).toBeNull();
    expect(noticeOf(screen([HEAD, LETTER_KEYS]))).toBeNull();
    expect(noticeOf(screen([...TRANSCRIPT, "  1: Yes    2: No     0: Dismiss"]))).toBeNull();
    expect(noticeOf(screen([...TRANSCRIPT, "  y: Yes    2: No     d: Don't ask again"]))).toBeNull();
    expect(noticeOf(screen([...TRANSCRIPT, "  yes: Yes    n: No"]))).toBeNull();
  });

  it("does not read digits a `letters` head carries on its own row", () => {
    const lettered = [{ head: "^● Can Anthropic look", letters: true as const }];
    const rows = plainRows(["● done", "", "● Can Anthropic look   1: Yes   2: No", RULE, "❯ ", RULE, "  model · ctx 3%"]);
    const frame = findInputFrame(rows, IDLE);
    expect(readAboveNotice(rows.map(rowText), frame!.top, lettered, GAPS)).toBeNull();
    expect(readAboveNotice(rows.map(rowText), frame!.top, [{ head: "^● Can Anthropic look" }], GAPS)?.keys.map((k) => k.key)).toEqual(["1", "2"]);
  });

  it("does not read the survey's head when the agent's prose quotes it with other rows under it", () => {
    const quoted = ["● How is Claude doing this session? (optional)", "  1: Bad    2: Fine   3: Good   0: Dismiss", "  That is the survey row I saw."];
    expect(noticeOf(screen(quoted))).toBeNull();
    expect(noticeOf(screen(["● The survey said: How is Claude doing this session? (optional)", "  1: Bad    2: Fine   3: Good   0: Dismiss"]))).toBeNull();
  });

  it("reads nothing with no notice shapes", () => {
    const rows = fixtureRows("claude--v2302-heads-up-above-box--w142.txt");
    expect(readAboveNotice(rows.map(rowText), findInputFrame(rows, IDLE)!.top, [], GAPS)).toBeNull();
  });
});

// The follow-ups Claude Code 2.1.304's plugin draws after a key on its notice: the Dismissed row, whose
// head carries the first keys, and the explanation under a head the profile marks `body`.
describe("the notice's follow-ups", () => {
  const DISMISSED = "✦ Dismissed.   1: That was helpful   2: Not relevant";
  const EXPLAINED_KEYS = "  1: Understood   2: Chat in main session   0: Dismiss";
  const bodyRows = (count: number): string[] => Array.from({ length: count }, (_, i) => `  - body row ${String(i)}`);

  it("reads an inline head: the head row carries the keys", () => {
    const notice = noticeOf(screen([`${DISMISSED}   0: Dismiss`, ""]));
    expect(notice?.text).toBe("Dismissed.");
    expect(notice?.keys).toEqual([
      { key: "1", label: "That was helpful" },
      { key: "2", label: "Not relevant" },
      { key: "0", label: "Dismiss" },
    ]);
    expect(notice?.first).toBe(2);
    expect(notice?.last).toBe(2);
    expect(notice?.body).toBeNull();
  });

  it("reads an inline head over a wrapped key block whose last row holds one key", () => {
    const notice = noticeOf(screen([DISMISSED, "  3: Couldn’t understand   4: Turn off suggestions", "  0: Dismiss", ""]));
    expect(notice?.text).toBe("Dismissed.");
    expect(notice?.keys.map((k) => k.key)).toEqual(["1", "2", "3", "4", "0"]);
    expect(notice?.keys.at(2)).toEqual({ key: "3", label: "Couldn’t understand" });
    expect(notice?.first).toBe(2);
    expect(notice?.last).toBe(4);
  });

  it("reads a body under a head the profile marks `body`, its blank edges trimmed", () => {
    const notice = noticeOf(screen([HEAD, "  cont", "", "  A title row", "  - one bullet", "    its wrapped row", "  - another", "", EXPLAINED_KEYS, ""]));
    expect(notice?.text).toBe(`${HEAD.slice(2)} cont`);
    expect(notice?.body).toEqual({ first: 5, last: 8 });
    expect(notice?.keys.map((k) => k.label)).toEqual(["Understood", "Chat in main session", "Dismiss"]);
    expect(notice?.first).toBe(2);
    expect(notice?.last).toBe(10);
  });

  it("reads the plain offer under a body head with no body", () => {
    expect(noticeOf(screen([HEAD, "  one", KEYS]))?.body).toBeNull();
  });

  it("reads a body of 58 rows between its two blank rows", () => {
    expect(noticeOf(screen([HEAD, "", ...bodyRows(58), "", EXPLAINED_KEYS]))?.body).toEqual({ first: 4, last: 61 });
  });

  it("reads a key block of six rows", () => {
    const six = ["  1: One   2: Two", "  3: Three", "  4: Four", "  5: Five", "  6: Six", "  0: Dismiss"];
    expect(noticeOf(screen([HEAD, ...six]))?.keys.map((k) => k.key)).toEqual(["1", "2", "3", "4", "5", "6", "0"]);
  });

  const failClosed: [string, string[]][] = [
    ["the same body under a head without `body`", ["● How is Claude doing this session? (optional)", "", "  A title row", "  - one bullet", "", EXPLAINED_KEYS]],
    ["a body row indented by one space", [HEAD, "", "  A title row", " - one bullet", "", EXPLAINED_KEYS]],
    ["a body row at the left edge", [HEAD, "", "  A title row", "- one bullet", "", EXPLAINED_KEYS]],
    ["61 body rows", [HEAD, "", ...bodyRows(61), "", EXPLAINED_KEYS]],
    ["a key row inside the body", [HEAD, "", "  A title row", "  1: Yes   2: No", "  - one bullet", "", EXPLAINED_KEYS]],
    ["a key block of seven rows", [HEAD, "  1: One   2: Two", "  3: Three", "  4: Four", "  5: Five", "  6: Six", "  7: Seven", "  0: Dismiss"]],
    ["an inline head whose keys hold a letter key", ["✦ Dismissed.   1: That was helpful   y: Yes", "  0: Dismiss"]],
  ];
  for (const [name, over] of failClosed) {
    it(`fails closed on ${name}`, () => {
      expect(noticeOf(screen(over))).toBeNull();
    });
  }
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

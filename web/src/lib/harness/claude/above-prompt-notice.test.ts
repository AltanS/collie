import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type StyledLine } from "../../blocks";
import { requireProfile } from "../../surface/profile";
import { readScreen } from "../../../test/surface-corpus";
import { blockOwnsKeyboard, dialogNounOf } from "../dialog-contract";
import { claudeAdapter, claudeBuildBlocks } from "./index";

// Claude Code 2.1.302's Heads up notice above a live box lifts as a `menu` card whose box stays live.

const PANES = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const HEADS_UP = "claude--v2302-heads-up-above-box--w142.txt";
const lines = (name: string): StyledLine[] => splitLines(parseAnsi(readFileSync(join(PANES, name), "utf8")));

/** The capture with `draft` typed into its empty box. */
function withDraft(draft: string): StyledLine[] {
  return lines(HEADS_UP).map((line) => (lineText(line).trim() === "❯" ? splitLines(parseAnsi(`❯ ${draft}`))[0]! : line));
}

describe("the notice above the box", () => {
  it("lifts the captured notice as a menu card: its text, and its three printed keys in order", () => {
    const blocks = claudeBuildBlocks(lines(HEADS_UP));
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "menu"]);
    const card = blocks[1]!;
    if (card.kind !== "menu") throw new Error("no menu");
    expect(card.menu.title).toBe(
      "Heads up · With GitHub triggers, anyone who files an issue on your public repos can put text in front of an unattended Claude session on your main PC.",
    );
    expect(card.menu.actions).toEqual([
      { label: "Learn more", keys: ["1"] },
      { label: "Knew this already", keys: ["2"] },
      { label: "Dismiss", keys: ["0"] },
    ]);
    expect(card.menu.nav).toEqual({ upDown: false });
    expect(card.menu.liveBox).toEqual({ draft: false });
    // The card mirrors the notice's rows; its binding region goes on down through the box (review F4).
    expect(card.menu.signature.startsWith(`${card.lines.map(lineText).join("\n")}\n`)).toBe(true);
    expect(card.lines).toHaveLength(3);
  });

  it("leaves the box live: the composer is ready and the card owns no keyboard", () => {
    const blocks = claudeBuildBlocks(lines(HEADS_UP));
    expect(claudeAdapter.composerReady?.(lines(HEADS_UP))).toBe(true);
    expect(blocks.some(blockOwnsKeyboard)).toBe(false);
    expect(dialogNounOf(blocks)).toBeNull();
  });

  it("keeps the transcript above the notice raw, and strips the box", () => {
    const raw = claudeBuildBlocks(lines(HEADS_UP))[0]!;
    if (raw.kind !== "raw") throw new Error("no raw block");
    expect(lineText(raw.lines.at(-1)!)).toContain("[-]");
  });

  it("marks the box's draft, so the card's keys wait", () => {
    const card = claudeBuildBlocks(withDraft("half a thought")).find((b) => b.kind === "menu");
    expect(card?.kind === "menu" && card.menu.liveBox).toEqual({ draft: true });
  });

  // The bridge binds the card's region only when it ends inside the last six non-blank rows of its read;
  // the region ends at the box's bottom edge, so up to five status rows may stand under it (review F5).
  it("lifts with one and three extra status rows under the box, and not with six", () => {
    const all = lines(HEADS_UP);
    const statusRow = all.at(-2)!;
    const taller = (extra: number) => [...all, ...Array.from({ length: extra }, () => statusRow)];
    expect(claudeBuildBlocks(taller(1)).some((b) => b.kind === "menu")).toBe(true);
    expect(claudeBuildBlocks(taller(3)).some((b) => b.kind === "menu")).toBe(true);
    expect(claudeBuildBlocks(taller(6)).some((b) => b.kind === "menu")).toBe(false);
  });

  it("lifts the notice with Claude Code's agents panel under the box: the panel is not counted against the tail", () => {
    expect(claudeBuildBlocks(lines("claude--v2302-notice-over-agents-panel--w69.txt")).map((b) => b.kind)).toEqual(["raw", "menu"]);
  });

  // Only the panel is left out, from its first named row down: the rows between the box and it count.
  it("lifts with five rows between the box and the agents panel, and not with six or more", () => {
    const all = lines("claude--v2302-notice-over-agents-panel--w69.txt");
    const withStatusRows = (extra: number) => [...all.slice(0, 69), ...Array.from({ length: extra }, () => all[67]!), ...all.slice(69)];
    expect(claudeBuildBlocks(withStatusRows(3)).some((b) => b.kind === "menu")).toBe(true);
    expect(claudeBuildBlocks(withStatusRows(4)).some((b) => b.kind === "menu")).toBe(false);
    expect(claudeBuildBlocks(withStatusRows(6)).some((b) => b.kind === "menu")).toBe(false);
  });

  // Plain output under the box, a blank row between (a shell under a Claude that has exited), walks as
  // the frame's generic footer, which is no named run: its rows count, as the bridge counts them.
  it("does not lift with a blank row and four to eight plain output rows under the box", () => {
    const raw = readFileSync(join(PANES, HEADS_UP), "utf8");
    for (let count = 4; count <= 8; count++) {
      const output = Array.from({ length: count }, (_, i) => `notes-${String(i)}.txt`);
      const screen = splitLines(parseAnsi([raw, "", ...output].join("\n")));
      expect(claudeBuildBlocks(screen).some((b) => b.kind === "menu"), `${String(count)} rows`).toBe(false);
    }
  });

  it("binds the card from the notice's head down through the box's bottom edge", () => {
    const card = claudeBuildBlocks(lines(HEADS_UP)).find((b) => b.kind === "menu");
    if (card?.kind !== "menu") throw new Error("no menu");
    const region = card.menu.signature.split("\n").map((row) => row.trimEnd());
    expect(region[0]).toMatch(/^✦ Heads up · /u);
    expect(region.at(-3)).toMatch(/^─+$/u);
    expect(region.at(-2)).toBe("❯");
    expect(region.at(-1)).toMatch(/^─+$/u);
  });

  // A survey drawn above the notice holds the keys, and the Surface reads the screen `unreadable`: the
  // notice's card must not lift beside it (review round 2).
  it("does not lift its card under a dialog stacked above it", () => {
    const rule = "─".repeat(60);
    const screen = [
      "● done",
      "",
      "● How is the agent doing this session? (optional)",
      "  1: Bad    2: Fine    3: Good    0: Dismiss",
      "",
      "✦ Heads up · Something new",
      "  one",
      "  two",
      "  three",
      "  1: Learn more   2: Knew this already   0: Dismiss",
      "",
      rule,
      "❯ ",
      rule,
      "  model · ctx 3%",
    ].join("\n");
    expect(claudeBuildBlocks(splitLines(parseAnsi(screen))).some((b) => b.kind === "menu")).toBe(false);
    expect(claudeBuildBlocks(lines(HEADS_UP)).some((b) => b.kind === "menu")).toBe(true);
  });

  // Seen live on 2026-10-17 at 69 columns: Claude Code's usage row in the blank row between the key
  // row and the box for about ten seconds after a turn. The composer read "Cannot read what is open".
  it("reads the notice over the usage row with the box free, so the composer does not lock", () => {
    const rule = "─".repeat(69);
    const seen = [
      `──── Sautéed for 5s ${"─".repeat(48)}…`,
      `${" ".repeat(65)}[-]`,
      "✦ Heads up · One of the notes says a nightly cleanup task",
      "  deletes everything on your X: drive at 03:00. All your repos",
      "  live on that drive.",
      "  1: Learn more   2: Knew this already   0: Dismiss",
      "  You've used 87% of your weekly limit · resets Oct 22, 1am (Ameri…",
      rule,
      "❯",
      rule,
      "  ctx:   9%  |  sub: 5h  49% (3h06m) · 7d  87% / F   1% (4d13h)  |…",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents",
    ].join("\n");
    const rows = splitLines(parseAnsi(seen));
    const read = readScreen(rows, "claude", requireProfile("claude").idle);
    expect(read.surface).toMatchObject({ modal: "none", composer: "empty" });
    expect(claudeAdapter.composerReady?.(rows)).toBe(true);
    const card = claudeBuildBlocks(rows).find((b) => b.kind === "menu");
    if (card?.kind !== "menu") throw new Error("no menu");
    expect(card.menu.actions.map((action) => action.keys)).toEqual([["1"], ["2"], ["0"]]);
    expect(card.lines.map(lineText).at(-1)).toBe("  1: Learn more   2: Knew this already   0: Dismiss");
  });

  // Seen live at 141 columns: when the usage row fits the pane, Claude Code right-aligns it, here from
  // column 18 to column 140. The statusline rows are replaced with neutral words of the same width.
  describe("over a usage row at 141 columns", () => {
    const rule = "─".repeat(142);
    const usage = "You've used 93% of your weekly limit · resets Oct 22, 1am (America/Los_Angeles) · /usage-credits to keep using Claude Code";
    const screenWithUsageAt = (column: number): StyledLine[] => {
      const seen = [
        "✢ Forming… · tool use (1m 31s · ↓ 1.7k tokens)",
        `  ⎿  ${"neutral words ".repeat(10).slice(0, 85)}`,
        `${" ".repeat(138)}[-]`,
        "✦ Heads up · One of the notes says a weekly report script emails customers' card numbers and home addresses to a public mailing list.",
        "  1: Learn more   2: Knew this already   0: Dismiss",
        `${" ".repeat(column)}${usage}`,
        rule,
        "❯ ",
        rule,
        `  ctx:  11%  |  ${"neutral words ".repeat(10).slice(0, 123)}…`,
        "  ⏵⏵ bypass permissions on (shift+tab to cycle) · neutral · ← 2 agents",
      ].join("\n");
      return splitLines(parseAnsi(seen));
    };

    it("reads the notice over the right-aligned row with the box free, and lifts its card", () => {
      const rows = screenWithUsageAt(18);
      expect(lineText(rows[5]!).trimEnd()).toHaveLength(140);
      expect(readScreen(rows, "claude", requireProfile("claude").idle).surface).toMatchObject({ modal: "none", composer: "empty" });
      expect(claudeBuildBlocks(rows).some((b) => b.kind === "menu")).toBe(true);
    });

    it("reads the notice over the same row at column 2, and lifts its card", () => {
      const rows = screenWithUsageAt(2);
      expect(readScreen(rows, "claude", requireProfile("claude").idle).surface).toMatchObject({ modal: "none", composer: "empty" });
      expect(claudeBuildBlocks(rows).some((b) => b.kind === "menu")).toBe(true);
    });
  });

});

// Decided 2026-10-19 (ADR 0109): Claude Code's rating survey is a notice like Heads up. On lane 8788 it
// stood over the box and every send was refused until it went; the owner ruled that it must not block
// sends and that the phone shows it as a card. Until then "does not lift the rating survey over the box"
// stood here.
describe("the rating survey above the box", () => {
  const FIELD = "claude--v2303-titled-edge-survey--w160.txt";
  const OLD = "claude-lab--survey-rating-above-box--w82.txt";
  const SURVEY_KEYS = [
    { label: "Bad", keys: ["1"] },
    { label: "Fine", keys: ["2"] },
    { label: "Good", keys: ["3"] },
    { label: "Dismiss", keys: ["0"] },
  ];
  const cardOf = (input: StyledLine[]) => {
    const card = claudeBuildBlocks(input).find((b) => b.kind === "menu");
    if (card?.kind !== "menu") throw new Error("no menu");
    return card;
  };

  it("lifts the field screen's survey as a card with its four buttons, over the update row and the titled edge", () => {
    const card = cardOf(lines(FIELD));
    expect(card.menu.title).toBe("How is Claude doing this session? (optional)");
    expect(card.menu.actions).toEqual(SURVEY_KEYS);
    expect(card.menu.liveBox).toEqual({ draft: false });
    expect(card.lines.map(lineText).map((text) => text.trimEnd())).toEqual(["● How is Claude doing this session? (optional)", "  1: Bad    2: Fine   3: Good   0: Dismiss"]);
    // The binding region runs from the head through the update row and the titled edge to the bottom edge.
    const region = card.menu.signature.split("\n").map((row) => row.trimEnd());
    expect(region[2]).toMatch(/^ +✔ Update installed · Restart to update$/u);
    expect(region.at(-3)).toMatch(/^─+ 1\.23\.0 ─$/u);
    expect(region.at(-1)).toMatch(/^─+$/u);
  });

  it("leaves the box live under the survey: the composer is ready and the card owns no keyboard", () => {
    const blocks = claudeBuildBlocks(lines(FIELD));
    expect(claudeAdapter.composerReady?.(lines(FIELD))).toBe(true);
    expect(blocks.some(blockOwnsKeyboard)).toBe(false);
    expect(dialogNounOf(blocks)).toBeNull();
  });

  it("lifts the same card with a blank row between the survey and the update row", () => {
    const rows = lines(FIELD);
    const keys = rows.findIndex((line) => lineText(line).startsWith("  1: Bad"));
    const gapped = [...rows.slice(0, keys + 1), splitLines(parseAnsi(""))[0] ?? { segments: [] }, ...rows.slice(keys + 1)];
    expect(cardOf(gapped).menu.actions).toEqual(SURVEY_KEYS);
  });

  it("lifts the 2.1.278 capture's survey the same way", () => {
    const card = cardOf(lines(OLD));
    expect(card.menu.title).toBe("How is Claude doing this session? (optional)");
    expect(card.menu.actions).toEqual(SURVEY_KEYS);
  });
});

// Claude Code 2.1.306's second survey question, keys `y`, `n`, `d`, under a head claude.json marks
// `letters` (captured 2026-10-21, 153 columns).
describe("the survey's transcript question above the box", () => {
  const FIXTURE = "claude--v2306-transcript-survey--w153.txt";

  it("lifts a card with Yes, No and Don't ask again, each its printed letter, and leaves the box live", () => {
    const blocks = claudeBuildBlocks(lines(FIXTURE));
    const card = blocks.find((b) => b.kind === "menu");
    if (card?.kind !== "menu") throw new Error("no menu");
    expect(card.menu.actions).toEqual([
      { label: "Yes", keys: ["y"] },
      { label: "No", keys: ["n"] },
      { label: "Don't ask again", keys: ["d"] },
    ]);
    expect(card.menu.liveBox).toEqual({ draft: false });
    expect(claudeAdapter.composerReady?.(lines(FIXTURE))).toBe(true);
    expect(blocks.some(blockOwnsKeyboard)).toBe(false);
  });
});

// Claude Code 2.1.304's follow-ups after a key on the Heads up notice: the Dismissed row, its keys on
// the head row and wrapped under it, and the explanation after Learn more, with its own key row.
describe("the Heads up follow-ups above the box", () => {
  const DISMISSED_KEYS = [
    { label: "That was helpful", keys: ["1"] },
    { label: "Not relevant", keys: ["2"] },
    { label: "Couldn’t understand", keys: ["3"] },
    { label: "Turn off suggestions", keys: ["4"] },
    { label: "Dismiss", keys: ["0"] },
  ];
  const AFTER_EXPLAIN_KEYS = [
    { label: "That was helpful", keys: ["1"] },
    { label: "Didn’t understand", keys: ["2"] },
    { label: "Dismiss", keys: ["0"] },
  ];
  const EXPLAINED_KEYS = [
    { label: "Understood", keys: ["1"] },
    { label: "Chat in main session", keys: ["2"] },
    { label: "Dismiss", keys: ["0"] },
  ];
  const cases: { fixture: string; title: string; actions: { label: string; keys: string[] }[] }[] = [
    { fixture: "claude--v2304-heads-up-dismissed--w135.txt", title: "Dismissed.", actions: DISMISSED_KEYS },
    { fixture: "claude--v2304-heads-up-dismissed--w65.txt", title: "Dismissed.", actions: DISMISSED_KEYS },
    { fixture: "claude--v2304-heads-up-dismissed-after-explain--w65.txt", title: "Dismissed.", actions: AFTER_EXPLAIN_KEYS },
    {
      fixture: "claude--v2304-heads-up-explained--w135.txt",
      title:
        "Heads up · One of the notes being read, 02-team, says a former CTO's admin access was never removed and was used yesterday from an unknown address.",
      actions: EXPLAINED_KEYS,
    },
    {
      fixture: "claude--v2304-heads-up-explained--w65.txt",
      title:
        "Heads up · One of the notes being read, 09-support, says the customer login site's security certificate expires tonight at midnight, and its renewal has been failing for two weeks.",
      actions: EXPLAINED_KEYS,
    },
  ];

  for (const { fixture, title, actions } of cases) {
    describe(fixture, () => {
      it("reads the box free: no modal, the composer empty and ready", () => {
        const rows = lines(fixture);
        expect(readScreen(rows, "claude", requireProfile("claude").idle).surface).toMatchObject({ modal: "none", composer: "empty" });
        expect(claudeAdapter.composerReady?.(rows)).toBe(true);
      });

      it("lifts a menu card with the head's text and the printed keys in printed order, the box live", () => {
        const card = claudeBuildBlocks(lines(fixture)).find((b) => b.kind === "menu");
        if (card?.kind !== "menu") throw new Error("no menu");
        expect(card.menu.title).toBe(title);
        expect(card.menu.actions).toEqual(actions);
        // The explanation's body rides on `liveBox` too; the cases below pin it.
        expect(card.menu.liveBox).toMatchObject({ draft: false });
      });
    });
  }

  // The explanation's body rides on the card's model as offsets into its own rows, so the card can show
  // it: from the body's title row down through the last row of its last bullet.
  const BODIES = [
    { fixture: "claude--v2304-heads-up-explained--w135.txt", first: "Former CTO's access may be in use now", last: "them." },
    { fixture: "claude--v2304-heads-up-explained--w65.txt", first: "Customer login certificate expires tonight", last: "date and renew it by hand today." },
  ];
  for (const { fixture, first, last } of BODIES) {
    it(`carries the explanation's body on the card's model: ${fixture}`, () => {
      const card = claudeBuildBlocks(lines(fixture)).find((b) => b.kind === "menu");
      if (card?.kind !== "menu") throw new Error("no menu");
      const body = card.menu.liveBox?.body;
      if (body === undefined) throw new Error("no body");
      const rows = card.lines.slice(body.start, body.end + 1).map((line) => lineText(line).trim());
      expect(rows[0]).toBe(first);
      expect(rows.at(-1)).toBe(last);
    });
  }

  for (const fixture of [
    "claude--v2304-heads-up-dismissed--w135.txt",
    "claude--v2304-heads-up-dismissed--w65.txt",
    "claude--v2304-heads-up-dismissed-after-explain--w65.txt",
    HEADS_UP,
  ]) {
    it(`carries no body on a card with none: ${fixture}`, () => {
      const card = claudeBuildBlocks(lines(fixture)).find((b) => b.kind === "menu");
      if (card?.kind !== "menu") throw new Error("no menu");
      expect(card.menu.liveBox).toBeDefined();
      expect(card.menu.liveBox).not.toHaveProperty("body");
    });
  }

  // Captured after Understood (2.1.304): the notice is gone. An existing capture with no notice over
  // its box stands in for it.
  it("lifts no menu card over a box with no notice above it", () => {
    const rows = lines("claude--v2303-titled-edge-working--w160.txt");
    expect(claudeBuildBlocks(rows).some((b) => b.kind === "menu")).toBe(false);
  });
});

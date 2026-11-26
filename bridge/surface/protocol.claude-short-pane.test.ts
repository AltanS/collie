// The Send Protocol on Claude Code in a short pane, replayed from the lab's reads of real sends (2026-11-25,
// Claude Code 2.1.332 over tmux, 56 columns). Under 16 rows Claude gives the rows under its box to a draft
// that needs them, last row first: at 14 rows the mode row goes once the box holds three rows, and at 12
// rows the statusline goes too. The rows under the box went from 2 to 1 (or 0) and the send ended
// typed_not_submitted (changed) with the text in the box; live, a long message from the phone into a
// 56 x 14 Herdr pane did the same. The profile now says its last rows under the box may go to a box that
// grew by as many (`idle.volatile.below.losesRows`). The statusline is the person's own text, so no hint
// pattern could name it. The lab's project path is shortened to `~/project`.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Profile } from "../../web/src/lib/surface/profile.ts";
import { DIALOG, FakePane, PROBE, neverEscape, rig, useScratchDir } from "./protocol.rig.ts";

useScratchDir();

const FIXTURES = join(import.meta.dir, "fixtures");
// eslint-disable-next-line no-control-regex
const SGR = /\u001b\[[0-9;:]*m/gu;

const LONG =
  "Long message from the phone, please just reply with the single word ok. It is long on purpose: in a short pane the draft wraps past the height of the input box, so the box scrolls and shows how many rows are above it, and Claude Code also gives the rows under the box to the draft once the box needs them. Nothing else to do here, only the one word ok in reply.";
const THREE_ROWS = "Short pane check from the phone: reply with the single word ok, and nothing else, so this test stays small.";

const panes = [
  { rows: 14, text: LONG, scrolled: true, under: ["~/project · Haiku 5.5"], word: ["only the one word ok", "only the one word no"] },
  { rows: 12, text: THREE_ROWS, scrolled: false, under: [], word: ["single word ok", "single word no"] },
] as const;
type Case = (typeof panes)[number];

const capture = (rows: number, name: string): string => readFileSync(join(FIXTURES, `claude--v2332-short-pane-${String(rows)}-rows-${name}--w56.txt`), "utf8");
const plainRows = (rows: number, name: string): string[] => capture(rows, name).replace(SGR, "").split("\n");

/** The rows under the box's bottom edge, blanks left out. */
function underBox(rows: readonly string[]): string[] {
  const bottom = rows.findLastIndex((row) => /^─{8,}$/u.test(row.trimEnd()));
  return rows.slice(bottom + 1).map((row) => row.trim()).filter((row) => row.length > 0);
}

/** A pane that shows the lab's read for what its box holds: `typed` stands for the whole text. */
function replay(c: Case, typed = capture(c.rows, "typed")): FakePane {
  const pane = new FakePane("claude");
  // The lab's Claude drew the text as typed: the fake folds no paste.
  pane.collapseOver = 100_000;
  let entered = false;
  pane.afterInput = (_p, what) => {
    if (what === "keys:Enter") entered = true;
  };
  pane.beforeRead = (p) => {
    if (entered) p.fixed = capture(c.rows, "sent");
    else if (p.box === "") p.fixed = capture(c.rows, "empty");
    else if (p.box === PROBE) p.fixed = capture(c.rows, "probe");
    else if (p.box === c.text) p.fixed = typed;
    else throw new Error(`the lab never saw the box hold ${JSON.stringify(p.box)}`);
  };
  return pane;
}

/** A test-local copy of the Claude profile without the rule. */
function withoutLosesRows(profile: Profile): Profile {
  const { losesRows: _flag, ...below } = profile.idle.volatile.below;
  void _flag;
  return { ...profile, idle: { ...profile.idle, volatile: { ...profile.idle.volatile, below } } };
}

describe("Claude Code 2.1.332 in a short pane gives the rows under its box to the draft, replayed from the lab's reads", () => {
  test("the profile sets the rule", async () => {
    const { loadProfiles } = await import("../../web/src/lib/surface/profile.ts");
    expect(loadProfiles().get("claude")?.idle.volatile.below.losesRows).toBe(true);
  });

  for (const c of panes) {
    test(`${String(c.rows)} rows: the captures show the statusline and the mode row under the empty box, and only the first ${String(c.under.length)} of them under the typed box`, () => {
      expect(underBox(plainRows(c.rows, "empty"))).toEqual(["~/project · Haiku 5.5", "⏵⏵ accept edits on (shift+tab to cycle)"]);
      expect(underBox(plainRows(c.rows, "probe"))).toEqual(underBox(plainRows(c.rows, "empty")));
      expect(underBox(plainRows(c.rows, "typed"))).toEqual([...c.under]);
      expect(plainRows(c.rows, "typed").some((row) => /^─── ↑ \d+ more ─+$/u.test(row.trimEnd()))).toBe(c.scrolled);
      expect(underBox(plainRows(c.rows, "sent"))).toEqual(underBox(plainRows(c.rows, "empty")));
    });

    test(`${String(c.rows)} rows: the message is sent with one Enter`, async () => {
      const pane = replay(c);
      const answer = await rig({ pane, version: "2.1.332" }).send(c.text);
      expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
      expect(pane.keysSeen.filter((key) => key === "Enter")).toHaveLength(1);
      neverEscape(pane);
    });

    test(`${String(c.rows)} rows: without the rule the send ends as it did live, typed_not_submitted (changed)`, async () => {
      const pane = replay(c);
      const answer = await rig({ pane, version: "2.1.332", edit: withoutLosesRows }).send(c.text);
      expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed", keys: ["probe", "Backspace"] });
      expect(pane.keysSeen).not.toContain("Enter");
    });

    test(`${String(c.rows)} rows: a box with a different word is still a mismatch, never submitted`, async () => {
      const typed = capture(c.rows, "typed").replace(c.word[0], c.word[1]);
      expect(typed).not.toBe(capture(c.rows, "typed"));
      const pane = replay(c, typed);
      const answer = await rig({ pane, version: "2.1.332" }).send(c.text);
      expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "mismatch" });
      expect(pane.keysSeen).not.toContain("Enter");
    });
  }

  test("14 rows: a row left under the box with changed text is still a changed screen, never submitted", async () => {
    const c = panes[0];
    const typed = capture(c.rows, "typed").replace("~/project · Haiku 5.5", "~/project · Opus 5.5");
    expect(typed).not.toBe(capture(c.rows, "typed"));
    const pane = replay(c, typed);
    const answer = await rig({ pane, version: "2.1.332" }).send(c.text);
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("14 rows: the first row gone and the last kept is still a changed screen, never submitted", async () => {
    const c = panes[0];
    const typed = capture(c.rows, "typed").replace("~/project · Haiku 5.5", "⏵⏵ accept edits on (shift+tab to cycle)");
    const pane = replay(c, typed);
    const answer = await rig({ pane, version: "2.1.332" }).send(c.text);
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("14 rows: rows NEW under the box are still a changed screen, never submitted", async () => {
    const c = panes[0];
    const rows = capture(c.rows, "typed").split("\n");
    const status = rows.findIndex((row) => row.replace(SGR, "").includes("~/project · Haiku 5.5"));
    expect(status).toBeGreaterThan(0);
    // Two rows: one in the mode row's place keeps S0's count, which the count alone already allowed.
    const pane = replay(c, [...rows.slice(2, status + 1), "  Background task finished", "  1 task done", ...rows.slice(status + 1)].join("\n"));
    const answer = await rig({ pane, version: "2.1.332" }).send(c.text);
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("12 rows: rows gone while the box kept its height are still a changed screen, never submitted", async () => {
    const c = panes[1];
    // The probe's read with the rows under the box blanked: the box holds one row, as at S0.
    const rows = capture(c.rows, "probe").split("\n");
    const bottom = rows.findLastIndex((row) => /^─{8,}$/u.test(row.replace(SGR, "").trimEnd()));
    const blanked = [...rows.slice(0, bottom + 1), ...rows.slice(bottom + 1).map(() => "")].join("\n");
    const pane = replay(c);
    pane.beforeRead = (p) => {
      if (p.box === "") p.fixed = capture(c.rows, "empty");
      else if (p.box === PROBE) p.fixed = blanked;
      else throw new Error(`the probe failed, so the box never holds ${JSON.stringify(p.box)}`);
    };
    const answer = await rig({ pane, version: "2.1.332" }).send(c.text);
    expect(answer.receipt?.outcome).toBe("refused");
    expect(answer.receipt?.reason).toBe("probe_failed");
    expect(pane.keysSeen).not.toContain("Enter");
  });
});

// The same lab reads with the rule on and the box grown, where something else moved as well. The rule excuses
// rows that left from the end of the rows under the box and nothing else: each of these still ends without Enter.
describe("losesRows never lets a screen that moved for another reason through", () => {
  const plain = (row: string): string => row.replace(SGR, "").trimEnd();
  const typedRows = (c: Case): string[] => capture(c.rows, "typed").split("\n");
  const bottomEdge = (rows: readonly string[]): number => rows.findLastIndex((row) => /^─{8,}$/u.test(plain(row)));
  /** The read cut to the pane's height from the top, so a row added under the box does not make the pane taller. */
  const fit = (c: Case, rows: readonly string[]): string => rows.slice(rows.length - c.rows).join("\n");

  test("14 rows: a permission dialog opens under the box while the mode row went: typed_not_submitted (modal_cue), never submitted", async () => {
    const c = panes[0];
    const rows = typedRows(c);
    const edge = bottomEdge(rows);
    const pane = replay(c, fit(c, [...rows.slice(0, edge + 1), ...DIALOG]));
    const answer = await rig({ pane, version: "2.1.332" }).send(c.text);
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("12 rows: the rows went and a NEW notice row stands under the box: typed_not_submitted (changed), never submitted", async () => {
    const c = panes[1];
    const rows = typedRows(c);
    const edge = bottomEdge(rows);
    const pane = replay(c, fit(c, [...rows.slice(0, edge + 1), "  Background task finished"]));
    const answer = await rig({ pane, version: "2.1.332" }).send(c.text);
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("14 rows: the mode row is replaced by the agents screen's key-hint row, the count of rows is kept: typed_not_submitted (changed, the other screen), never submitted", async () => {
    const c = panes[0];
    const rows = typedRows(c);
    const status = rows.findIndex((row) => plain(row).includes("~/project · Haiku 5.5"));
    expect(status).toBeGreaterThan(0);
    const pane = replay(c, fit(c, [...rows.slice(0, status + 1), "  enter to return"]));
    const answer = await rig({ pane, version: "2.1.332" }).send(c.text);
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).not.toContain("Enter");
  });

  // With rows under the box (14 rows) the read with no box is a changed screen; with nothing under it (12 rows) the Surface
  // cannot read the pane at all and claims an unreadable modal. Both end without Enter.
  const noFrame = [
    { c: panes[0], reason: "changed" },
    { c: panes[1], reason: "modal_cue" },
  ] as const;
  for (const { c, reason } of noFrame) {
    test(`${String(c.rows)} rows: the frame is gone at the later read: typed_not_submitted (${reason}), never submitted`, async () => {
      // The lab's typed read with both edges of the box blanked: the text stands where it stood, with no box around it.
      const rows = typedRows(c).map((row) => (plain(row).startsWith("─") ? "" : row));
      const pane = replay(c, rows.join("\n"));
      const answer = await rig({ pane, version: "2.1.332" }).send(c.text);
      expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason });
      expect(pane.keysSeen).not.toContain("Enter");
    });
  }
});

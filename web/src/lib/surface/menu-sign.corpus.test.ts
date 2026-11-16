import { describe, expect, it } from "vitest";

import { agentOf, fixtureRows, idleFor, loadLabels, readScreen } from "../../test/surface-corpus";
import { noticeOver } from "./cues";
import { findInputFrame, rowText } from "./frame";
import { menuSign, type MenuBox } from "./menu-sign";

// M102 spec 12, decision 4: the generic menu sign, run over every dialog fixture and every idle fixture
// of every harness. Two readings:
//  - as the bridge applies it (bridge/surface/protocol.ts `menuBoxOf`): a box the profile found counts
//    while the reader saw no dialog (modal none, or a weak cue), and its rows, a notice the profile names
//    over it and the named footer rows under it are left out;
//  - profile-free, with no box at all: the reading on a screen whose box the reader did not find, and
//    the one every unreadable read gets.
// The target: at least 98 % of dialog fixtures, at most 1 % of idle fixtures, every miss listed.

interface Case {
  readonly name: string;
  readonly state: string;
  readonly texts: string[];
  readonly box: MenuBox | null;
}

function cases(): Case[] {
  const out: Case[] = [];
  for (const [name, label] of Object.entries(loadLabels().fixtures)) {
    if (label.state !== "dialog" && label.state !== "idle") continue;
    const rows = fixtureRows(name);
    const texts = rows.map(rowText);
    const idle = idleFor(label.harness);
    const frame = idle === null ? null : findInputFrame(rows, idle);
    const { modal } = readScreen(rows, agentOf(label.harness), idle).surface;
    let box: MenuBox | null = null;
    if (frame !== null && (modal === "none" || modal === "unknown")) {
      const skip = new Set<number>();
      for (let i = frame.interior.first; i <= frame.interior.last; i++) skip.add(i);
      const notice = noticeOver(texts, frame, idle);
      if (notice !== null) for (let i = notice.first; i <= notice.end; i++) skip.add(i);
      for (const hit of frame.volatile.named) skip.add(hit.row);
      box = { top: frame.top, skip };
    }
    out.push({ name, state: label.state, texts, box });
  }
  return out;
}

const ALL = cases();
const DIALOGS = ALL.filter((c) => c.state === "dialog");
const IDLES = ALL.filter((c) => c.state === "idle");

/**
 * The idle fixtures the sign fires on as the bridge applies it. Both are Claude Code's agents panel
 * under the box with the panel focused ("↑/↓ to select"): the arrow keys and Enter act on the panel's
 * list there, so the sign is right to read a menu, though the label says idle.
 */
const IDLE_HITS = ["claude--v2301-lab-agents-panel-focused.txt", "claude--v2322-macos-agents-panel-focused--w80.txt"];

/**
 * The dialog fixtures the sign misses as the bridge applies it. Claude Code's agents screen at 40
 * columns: its own box ("describe a task for a new session") is found and reads modal none, and the
 * one hint under it ("enter to return") names no menu verb. The profile names that screen as another
 * screen (`otherScreens`), which the steps refuse on their own; with no box (the profile-free reading)
 * the sign reads its two key hints above the box.
 */
const DIALOG_MISSES = ["claude-lab--agents-screen--w40.txt"];

describe("the generic menu sign over the fixture corpus", () => {
  it("has both sets to read", () => {
    expect(DIALOGS.length).toBeGreaterThan(700);
    expect(IDLES.length).toBeGreaterThan(200);
  });

  it("as the bridge applies it: fires on at least 98 % of dialog fixtures, and misses only the listed ones", () => {
    const misses = DIALOGS.filter((c) => menuSign(c.texts, c.box) === null).map((c) => c.name);
    expect(misses.toSorted()).toEqual(DIALOG_MISSES.toSorted());
    expect(1 - misses.length / DIALOGS.length).toBeGreaterThanOrEqual(0.98);
  });

  it("as the bridge applies it: fires on at most 1 % of idle fixtures, only the listed ones", () => {
    const hits = IDLES.filter((c) => menuSign(c.texts, c.box) !== null).map((c) => c.name);
    expect(hits.toSorted()).toEqual(IDLE_HITS.toSorted());
    expect(hits.length / IDLES.length).toBeLessThanOrEqual(0.01);
  });

  it("profile-free (no box): fires on every dialog fixture", () => {
    expect(DIALOGS.filter((c) => menuSign(c.texts, null) === null).map((c) => c.name)).toEqual([]);
  });

  it("profile-free (no box): the false rate on idle screens stays where it was measured (35 of 229 on 2026-11-16)", () => {
    // With no box to set the person's text and the transcript apart, a list in the agent's answer, a
    // notice's digit row and a login screen's "Esc to cancel" read as a menu. That costs the person a
    // press on the key pad on a screen whose box the reader did not find, never a wrong key.
    const hits = IDLES.filter((c) => menuSign(c.texts, null) !== null).length;
    expect(hits / IDLES.length).toBeLessThanOrEqual(0.16);
  });
});

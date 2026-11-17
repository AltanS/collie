import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { agentOf, fixtureRows, idleFor, loadLabels, readScreen } from "../../test/surface-corpus";
import { noticeOver } from "./cues";
import { findInputFrame, rowText } from "./frame";
import { ANCHOR_ROWS, menuSign, type MenuBox } from "./menu-sign";

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

  it("profile-free (no box): the false rate on idle screens stays where it was measured (36 of 230 on 2026-11-17)", () => {
    // With no box to set the person's text and the transcript apart, a list in the agent's answer, a
    // notice's digit row and a login screen's "Esc to cancel" read as a menu. That costs the person a
    // press on the key pad on a screen whose box the reader did not find, never a wrong key.
    const hits = IDLES.filter((c) => menuSign(c.texts, null) !== null).length;
    expect(hits / IDLES.length).toBeLessThanOrEqual(0.16);
  });
});

/** Hand-written shell screens (`fixtures/shell-screens/`): old output above a prompt, a REPL, a pager, a running program. */
const SHELL_DIR = join(import.meta.dirname, "..", "..", "fixtures", "shell-screens");
const SHELLS = readdirSync(SHELL_DIR).map((file) => ({ name: file, texts: readFileSync(join(SHELL_DIR, file), "utf8").replace(/\n$/u, "").split("\n") }));
const ANCHORED = { anchor: ANCHOR_ROWS };

/** The dialog fixtures the anchored reading misses, measured 2026-11-17: an agent draws more than K rows that are no menu part under them (a palette or a picker over a tall status). On the blind road each of them shows a profile's rows, which reads the whole window. */
const ANCHORED_DIALOG_MISSES = [
  "oc--agents-picker.txt",
  "oc--command-palette-query.txt",
  "oc--command-palette.txt",
  "oc--update-available.txt",
  "oc--v226-command-palette.txt",
  "oc--v226-models-picker.txt",
  "oc--v1195-slash-comp.txt",
];

/** The one shell screen the anchored reading fires on: a dev server's key list ("press r + enter to restart") that waits for a key. */
const ANCHORED_SHELL_HITS = ["npm-run-dev-help.txt"];

describe("the anchored reading (the blind road on a program or an unknown foreground)", () => {
  it("has at least 40 shell screens to read", () => {
    expect(SHELLS.length).toBeGreaterThanOrEqual(40);
  });

  it("fires on at least 98 % of dialog fixtures with no box, and misses only the listed ones", () => {
    const misses = DIALOGS.filter((c) => menuSign(c.texts, null, ANCHORED) === null).map((c) => c.name);
    expect(misses.toSorted()).toEqual(ANCHORED_DIALOG_MISSES.toSorted());
    expect(1 - misses.length / DIALOGS.length).toBeGreaterThanOrEqual(0.98);
  });

  it("fires on at most 5 % of the shell screens, only the listed ones", () => {
    const hits = SHELLS.filter((c) => menuSign(c.texts, null, ANCHORED) !== null).map((c) => c.name);
    expect(hits.toSorted()).toEqual(ANCHORED_SHELL_HITS.toSorted());
    expect(hits.length / SHELLS.length).toBeLessThanOrEqual(0.05);
  });

  it("the false rate on idle screens with no box stays where it was measured (30 of 230 on 2026-11-17, above the 5 % goal)", () => {
    // An idle agent's answer list sits a few rows over its box and status, as a dialog's options do: with
    // no box, K cannot tell the two apart. Kept for the dialog rate, which comes first.
    const hits = IDLES.filter((c) => menuSign(c.texts, null, ANCHORED) !== null).length;
    expect(hits / IDLES.length).toBeLessThanOrEqual(0.14);
  });

  it("leaves a found box's reading as it was", () => {
    for (const c of ALL.filter((one) => one.box !== null)) expect(menuSign(c.texts, c.box, ANCHORED)).toEqual(menuSign(c.texts, c.box));
  });

  it("reads old output above a prompt as no menu, and a live question at the bottom as one", () => {
    expect(menuSign(["$ cat -n list.txt", "     1  alpha", "     2  beta", "     3  gamma", "$ "], null, ANCHORED)).toBeNull();
    expect(menuSign(["$ sudo apt upgrade", "Do you want to continue? [Y/n] y", "Setting up curl ...", "$ "], null, ANCHORED)).toBeNull();
    expect(menuSign(["$ sudo apt upgrade", "4 upgraded, 0 newly installed.", "Do you want to continue? [Y/n] "], null, ANCHORED)).toEqual({ kind: "yes-no", row: 2 });
    expect(menuSign(["1) dev", "2) staging", "3) production", "#? "], null, ANCHORED)).toEqual({ kind: "numbered", row: 0 });
  });
});

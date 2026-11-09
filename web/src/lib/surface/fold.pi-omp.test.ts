import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { StyledLine } from "../blocks";
import { agentOf, fixtureRows, idleFor, PANES_DIR, readScreen, rowsOf, SURFACE_FIXTURES_DIR } from "../../test/surface-corpus";
import { pointsAt } from "./command-list";
import { commandListAt, ownCommandList, runningSign } from "./cues";
import { findInputFrame, rowText } from "./frame";
import { stripSgr } from "./plain";
import { askOf, isFree } from "./surface";
import { CORPUS_WALK, FIXTURES, labelOf, own } from "../../test/surface-fold";

describe("pi's dialogs under its profile", () => {
  // The pi profile takes an extension's painted footer under the box (`idle.frame.underPainted`, issue
  // 485). pi paints much more than footers, so this pins that no pi dialog, a cut one included, reads
  // as a box with no modal: with `modal: none` the phone offers Replace, which types into the dialog.
  it("no pi dialog fixture reads modal none, the ones cut on purpose too", CORPUS_WALK, () => {
    const dialogs = FIXTURES.filter((name) => labelOf(name).harness === "pi" && labelOf(name).state === "dialog");
    expect(dialogs.length).toBeGreaterThan(60);
    expect(dialogs.filter((name) => own(name).surface.modal === "none")).toEqual([]);
  });

  // The omp profile names its command list too (1.22.5): a box past a list may be found where none was.
  it("no omp dialog fixture reads modal none, the ones cut on purpose too", CORPUS_WALK, () => {
    const dialogs = FIXTURES.filter((name) => labelOf(name).harness === "omp" && labelOf(name).state === "dialog");
    expect(dialogs.length).toBeGreaterThan(60);
    expect(dialogs.filter((name) => own(name).surface.modal === "none")).toEqual([]);
  });
});

describe("the typed command's own list under pi's and omp's box (field case 2026-10-17, 1.22.5)", () => {
  // Captured in an isolated Herdr session: pi 1.3.0, pi 0.87.1 and omp 18.6.1 with `/model` or
  // `/settings` typed, at 120 and 80 columns. Each list points at the typed command, so Enter picks
  // that command: a draft with no modal. Until 1.22.5 the list's pointer row and the slash query in
  // the box read as a strong cue (pi), or the list hid the box (omp), so the phone's Model shortcut
  // was left typed with `typed_not_submitted (modal_cue)`.
  const OWN: readonly [string, string][] = [
    ["pi--v130-slash-model-list--w120.txt", "/model"],
    ["pi--v130-slash-model-list--w80.txt", "/model"],
    ["pi--v140-slash-model-list--w120.txt", "/model"],
    ["pi--v130-slash-settings-list--w120.txt", "/settings"],
    ["pi--v130-slash-settings-list--w80.txt", "/settings"],
    ["pi--v0871-slash-model-list--w120.txt", "/model"],
    ["pi--v0871-slash-model-list--w80.txt", "/model"],
    ["pi--v0871-slash-settings-list--w120.txt", "/settings"],
    ["pi--v0871-slash-settings-list--w80.txt", "/settings"],
    ["omp--v18-6-slash-model-list--w120.txt", "/model"],
    ["omp--v18-6-slash-model-list--w80.txt", "/model"],
    ["omp--v18-6-slash-settings-list--w120.txt", "/settings"],
    ["omp--v18-6-slash-settings-list--w80.txt", "/settings"],
    // symbolPreset ascii draws the list cursor as `>` (omp-gang 11-geometry, 2026-10-25).
    ["omp--v18-6-1-ascii-symbols-session-list--w130.txt", "/session"],
    ["omp--v18-12-6-ascii-symbols-session-list--w130.txt", "/session"],
    // The older captures of the same state: OmO on pi, omp 18.8's pi-shaped box (commit 9acc1502) and an older omp box.
    ["pi--omo-v5130-slash-model.txt", "/model"],
    ["pi--omo-v5130-slash-compact.txt", "/compact"],
    ["omp--v18-8-slash-palette.txt", "/resume"],
    ["omp--v18-8-slash-palette-w48.txt", "/resume"],
    ["omp--slash-palette--filtered.txt", "/new"],
  ];

  for (const [name, command] of OWN) {
    it(`${name}: the box holds ${command}, its own list under it is no dialog`, () => {
      const read = own(name);
      expect(read.frame?.interior.text).toBe(command);
      expect(read.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
      expect(read.cues?.strength).toBe("none");
      expect(labelOf(name).state).toBe("popup");
    });
  }

  // The selector `/model` opens and the settings screen `/settings` opens stay dialogs. pi and omp name
  // `leadOpens`: their fuzzy list under a box that starts with `/` is that text's own popup whatever it
  // points at (below; pi since issue 638).
  for (const name of [
    "pi--v130-model-selector-empty--w120.txt",
    "pi--v0871-model-selector-empty--w120.txt",
    "omp--v18-6-model-selector-empty--w120.txt",
    "pi--v130-settings-screen--w120.txt",
    "omp--v18-6-settings-screen--w120.txt",
  ]) {
    it(`${name}: still reads as a dialog`, () => {
      const read = own(name);
      expect(read.surface.modal).toBe("unreadable");
      expect(isFree(read.surface)).toBe(false);
      expect(labelOf(name).state).toBe("dialog");
    });
  }

  it("on pi a list that points at another command is the typed text's own list (leadOpens, issue 638)", () => {
    const name = "pi--v130-slash-mod-partial--w120.txt";
    const rows = fixtureRows(name);
    const idle = idleFor("pi")!;
    const frame = findInputFrame(rows, idle);
    const texts = rows.map(rowText);
    expect(frame?.interior.text, name).toBe("/mod");
    expect(ownCommandList(texts, frame, idle)?.pointed, name).toBe("/model");
    expect(pointsAt(commandListAt(texts, frame!, idle.volatile.below.commandList)!, "/mod", idle.volatile.below.commandList), name).toBe(false);
  });

  // omp's list is a fuzzy one: `/mod` lists ten commands that match it in part, the pointer on `model`
  // (`leadOpens`). The box is found past the whole list, the list is read, and it is the text's own popup;
  // that Enter would run `model` and not `/mod` is the protocol's question, answered by `pointsAt`.
  for (const name of ["omp--v18-6-slash-mod-partial--w120.txt", "omp--slash-palette.txt"]) {
    it(`${name}: omp's fuzzy list is the typed text's popup, pointed at another command or not`, () => {
      const read = own(name);
      expect(read.frame).not.toBeNull();
      expect(read.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
      expect(read.cues?.strength).toBe("none");
      expect(labelOf(name).state).toBe("popup");
      const idle = idleFor("omp")!;
      const rows = fixtureRows(name);
      const texts = rows.map(rowText);
      const list = commandListAt(texts, read.frame!, idle.volatile.below.commandList);
      expect(list?.side, name).toBe("under");
      expect(pointsAt(list!, read.frame!.interior.text, idle.volatile.below.commandList), name).toBe(false);
    });
  }
});

describe("omp's default band composer under the nerd preset (omp 18.12.1, issue 505)", () => {
  // The band draws the status line as the top row with no `╭──` edge. Under the nerd preset it opens on
  // the powerline cap U+E0B6 and the pi glyph U+F0D57, and closes its segments with U+E0B0 where the
  // unicode preset draws `π` and `▶`, so before 505 no frame was found and every send was refused.
  const DRAFTS: readonly [string, string][] = [
    ["omp--v18-12-nerd-band-draft--w130.txt", "please check the build"],
    ["omp--v18-12-nerd-band-draft--w80.txt", "please check the build"],
    ["omp--v18-12-nerd-band-two-lines--w130.txt", "please check the build and report back"],
    ["omp--v18-12-nerd-band-two-lines--w80.txt", "please check the build and report back"],
    [
      "omp--v18-12-nerd-band-wrapped--w130.txt",
      "the quick brown fox jumps over the lazy dog while the band composer wraps this long draft across more than one row of the terminal so collie has to fold it back together",
    ],
    [
      "omp--v18-12-nerd-band-wrapped--w80.txt",
      "the quick brown fox jumps over the lazy dog while the band composer wraps this long draft across more than one row of the terminal so collie has to fold it back together",
    ],
  ];

  for (const name of [
    "omp--v18-12-nerd-band-idle--w130.txt",
    "omp--v18-12-nerd-band-idle--w80.txt",
    "omp--v18-12-nerd-band-done--w130.txt",
    "omp--v18-12-nerd-band-done--w80.txt",
    "omp--v18-12-band-idle--w130.txt",
  ]) {
    it(`${name}: reads an empty box, free`, () => {
      const read = own(name);
      expect(read.frame).not.toBeNull();
      expect(read.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    });
  }

  // The widened top and rows patterns must not read a transcript line as the band. Each decoy takes the
  // place of the band's top row in a real capture: a powerline glyph with no pi glyph or spinner after it,
  // a closer with no `─` run, a row indented past the top anchor's column, and a closer in running prose.
  const BAND = "\u{E0B6} \u{F0D57} \u{E0B1} Haiku 4.5 \u{E0B1} project \u{E0B0}\u2500\u2500\u25004%\u2500\u2500\u2500\u2500200K\u2500";
  const DECOYS: readonly [string, string][] = [
    ["a cap and prose, no pi glyph or spinner", "\u{E0B6} the build is green \u{E0B0}\u2500\u2500\u2500 done"],
    ["a pi glyph and a closer with no rule run", "\u{E0B6} \u{F0D57} notes \u{E0B0} done"],
    ["a banded row indented past the anchor column", "    \u{F0D57} notes \u{E0B0}\u2500\u2500\u2500 done"],
    ["a closer inside a sentence", "see the \u{E0B0}\u2500\u2500\u2500 glyph in the status line"],
  ];

  it("a band row put back over the capture's top row is found (the control for the decoys)", () => {
    const name = "omp--v18-12-nerd-band-idle--w130.txt";
    const rows = [...fixtureRows(name)];
    rows[own(name).frame!.top] = { segments: [{ text: BAND, style: {}, muted: false }] };
    expect(findInputFrame(rows, idleFor("omp")!)).not.toBeNull();
  });

  for (const [what, line] of DECOYS) {
    it(`${what} is no band top row`, () => {
      const name = "omp--v18-12-nerd-band-idle--w130.txt";
      const rows = [...fixtureRows(name)];
      rows[own(name).frame!.top] = { segments: [{ text: line, style: {}, muted: false }] };
      expect(findInputFrame(rows, idleFor("omp")!)).toBeNull();
    });
  }

  for (const [name, draft] of DRAFTS) {
    it(`${name}: reads the draft, the ghost word left out`, () => {
      const read = own(name);
      expect(read.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
      expect(read.frame!.interior.text.replace(/\s+/gu, " ").trim()).toBe(draft);
    });
  }

  for (const name of [
    "omp--v18-12-nerd-band-running--w130.txt",
    "omp--v18-12-nerd-band-running--w80.txt",
    "omp--v18-12-nerd-band-running-minute--w130.txt",
  ]) {
    it(`${name}: the spinner in the band reads as a running turn`, () => {
      const read = own(name);
      expect(read.frame).not.toBeNull();
      expect(read.surface.turn).toBe("running");
      expect(isFree(read.surface)).toBe(false);
    });
  }
});

describe("omp 18.11.1's band under any status line style (issue 505)", () => {
  // Real captures, omp 18.11.1 in a scratch Herdr pane, nerd preset unless named. The stock row closes its
  // segments with U+E0B0 before the `─` run. `statusLine.transparent` drops the caps (no U+E0B6, no
  // U+E0B0), the `slash` separator draws U+E0BB, the `minimal` preset has no pi glyph, and the `ascii`
  // preset writes `pi >` and fills with `-`. Before 505 only the stock row was read as the top edge.
  const IDLE = [
    "omp--v18.11.1-powerline-idle--w120.txt",
    "omp--v18.11.1-powerline-transparent-idle--w120.txt",
    "omp--v18.11.1-slash-idle--w120.txt",
    "omp--v18.11.1-minimal-idle--w120.txt",
    "omp--v18.11.1-ascii-idle--w120.txt",
  ];
  const DRAFTS = ["omp--v18.11.1-powerline-draft--w120.txt", "omp--v18.11.1-powerline-transparent-draft--w120.txt"];

  for (const name of IDLE) {
    it(`${name}: reads an empty box, free`, () => {
      const read = own(name);
      expect(read.frame).not.toBeNull();
      expect(read.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
      expect(isFree(read.surface)).toBe(true);
    });
  }

  for (const name of DRAFTS) {
    it(`${name}: reads the draft, the ghost word left out`, () => {
      const read = own(name);
      expect(read.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
      expect(read.frame!.interior.text.replace(/\s+/gu, " ").trim()).toBe("please check the build");
    });
  }

  // Built rows, not captures: each takes the band's place in the transparent capture. A turn puts the
  // spinner and its time where the pi glyph sits, and with no closer it must still read as running.
  const capture = "omp--v18.11.1-powerline-transparent-idle--w120.txt";
  const withTop = (line: string) => {
    const rows = [...fixtureRows(capture)];
    rows[own(capture).frame!.top] = { segments: [{ text: line, style: {}, muted: false }] };
    return rows;
  };

  it("a spinner band with no caps reads as a running turn", () => {
    const rows = withTop(" ⠋ 14s \u{E0B1} \u{EC19} Opus 5.5 · high \u{E0B1} \u{F014} /tmp  ───2%────1M─");
    const frame = findInputFrame(rows, idleFor("omp")!);
    expect(frame).not.toBeNull();
    expect(runningSign(rows, frame!, idleFor("omp")!.runningRows)).toBe(true);
  });

  // The rule needs an icon (not a word, not a bare powerline glyph) at column 0 or 1, then a `─` or `-` run.
  const DECOYS: readonly [string, string][] = [
    ["a word before the rule run", " the build is green ─── done"],
    ["a bare separator glyph before prose", "\u{E0B1} see the ─── rule"],
    ["an icon with no rule run", " \u{F0D57} notes \u{E0B1} done"],
  ];
  for (const [what, line] of DECOYS) {
    it(`${what} is no band top row`, () => {
      expect(findInputFrame(withTop(line), idleFor("omp")!)).toBeNull();
    });
  }
});

describe("a soft-wrapped draft in pi's box is no menu (issue 553)", () => {
  // Built rows in the shape of the field screen: a model label, a blank row, the 139-cell top rule, the
  // prompt row `❯ ` and the draft's wrapped rows indented to column 2, the bottom rule as the last row.
  // The `❯` and the aligned continuation rows read as a pointed list between two rules, so the frame was
  // dropped, the box read as hidden by a dialog, and Send stopped at "Enter was not pressed".
  const WIDTH = 139;
  const RULE = "─".repeat(WIDTH);
  const PROSE =
    "please look at the failing build on the main branch and find out why the integration suite times out after the last merge, then write down what you find in the notes file so we can talk about it tomorrow morning before the release goes out, and if the cause is the new cache layer check whether turning it off makes the suite pass again on a clean checkout of the branch without any local state left over from earlier runs, and also tell me which commits touched the scheduler since the last green build before we decide anything about the release, and write the summary in plain words so the rest of the team can follow it, ok";
  const row = (text: string) => ({ segments: [{ text, style: {}, muted: false }] });

  /** The words wrapped the way the editor wraps them: greedy, at the box's width less the two-cell lead. */
  function wrapped(words: readonly string[], width = WIDTH - 2): string[] {
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      if (line.length > 0 && line.length + 1 + word.length > width) {
        lines.push(line);
        line = word;
      } else line = line.length === 0 ? word : `${line} ${word}`;
    }
    if (line.length > 0) lines.push(line);
    return lines;
  }

  function screen(lines: readonly string[]) {
    const label = "claude-opus-5-5 · high";
    return [
      row(`${" ".repeat(WIDTH - label.length)}${label}`),
      row(""),
      row(RULE),
      ...lines.map((line, i) => row(`${i === 0 ? "❯ " : "  "}${line}`)),
      row(RULE),
    ];
  }

  const read = (lines: readonly string[]) => readScreen(screen(lines), agentOf("pi"), idleFor("pi"));

  const DRAFTS: readonly [string, string[]][] = [
    ["the field case's five-row draft", wrapped(PROSE.split(" "))],
    ["a two-row draft", wrapped(PROSE.split(" ").slice(0, 30))],
  ];
  for (const [what, lines] of DRAFTS) {
    it(`${what} reads as a draft with no modal`, () => {
      expect(lines.length).toBe(what.startsWith("a two") ? 2 : 5);
      const got = read(lines);
      expect(got.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
      expect(got.cues?.strength).not.toBe("strong");
      expect(got.frame?.interior.text).toBe(lines.join(" "));
    });
  }

  // The field screen's bytes: gentle-pi 4.3.0 on pi 1.3.0, 201 columns, a five-row draft not sent.
  it("the captured wrapped draft reads as a draft with no modal", () => {
    const got = own("pi--v130-gentle-draft-wrapped.txt");
    expect(got.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
    expect(got.cues?.strength).not.toBe("strong");
    expect(got.frame?.interior.text.startsWith("This is a draft typed to capture")).toBe(true);
    expect(got.frame?.interior.text.endsWith("look at first and why.")).toBe(true);
  });

  // pi draws a menu or hint row wider than the box cut short with an ellipsis, which fills the width the
  // way a soft wrap does, so a wrapped draft and a cut menu look the same. Neither reading is safe (a
  // draft's Enter answers a menu; a menu tap's Enter submits a draft), so the read is unreadable: no
  // dialog, no taps, no draft, nothing free. The older reading, a pointed list, offered a false dialog.
  // Synthetic variations: the field draft's rows with the last word of one row replaced by the ellipsis.
  const ELLIPSES: readonly [string, string][] = [
    ["the ellipsis character", "…"],
    ["three ASCII dots", "..."],
  ];
  for (const [what, ending] of ELLIPSES) {
    for (const [where, rowAt] of [["a middle row", 1], ["the last row", 4]] as const) {
      it(`a draft row ending in ${what} (${where}) reads as unreadable, never as a dialog`, () => {
        const lines = wrapped(PROSE.split(" "));
        expect(lines.length).toBe(5);
        lines[rowAt] = `${lines[rowAt]!.replace(/\S+$/u, "")}${ending}`;
        const got = read(lines);
        expect(got.cues?.cutWrap).toBe(true);
        expect(got.cues?.strength).toBe("none");
        expect(got.surface).toMatchObject({ modal: "unknown", composer: "unknown", reason: "no-match" });
        expect(askOf(got.surface.modal)).toBeNull();
        expect(isFree(got.surface)).toBe(false);
      });
    }
  }

  it("the same rows without an ellipsis still read as a draft", () => {
    const lines = wrapped(PROSE.split(" "));
    const got = read(lines);
    expect(got.cues?.cutWrap).toBeUndefined();
    expect(got.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
    expect(got.frame?.interior.text).toBe(lines.join(" "));
  });

  // The controls stay dialogs: a choice between the rules is no soft wrap. An explicit-newline draft of
  // short rows reads the same as such a list, so with no caret cell it stays a dialog too, the conservative
  // side; the editor's own caret cell is what reads it as a draft (issue 722, below).
  const MENUS: readonly [string, string[]][] = [
    ["a yes/no choice", ["Yes", "No"]],
    ["a three-option menu", ["Option one", "Option two", "Option three"]],
    ["a draft of short rows, typed with newlines (known, conservative)", ["fix the build", "then run the tests", "and report back"]],
  ];
  for (const [what, lines] of MENUS) {
    it(`${what} between the rules still reads as a dialog`, () => {
      const got = read(lines);
      expect(got.cues?.strength).toBe("strong");
      expect(got.surface.modal).not.toBe("none");
      expect(isFree(got.surface)).toBe(false);
    });
  }

  // An open box (omp) ends on its statusline, narrower than the box: the width to fill is the top edge's.
  // Measured on the statusline, these three options of about 65 cells read as a wrapped draft.
  it("a menu in omp's open box is measured against the top edge, not the statusline", () => {
    const name = "omp--v18-4-borderless-wrapped.txt";
    const idle = idleFor("omp")!;
    const rows = fixtureRows(name);
    const frame = findInputFrame(rows, idle)!;
    const options = [
      "❯ Allow the agent to run this command once, in this workspace only",
      "  Allow the agent to run this command always, in every workspace",
      "  Deny the command and tell the agent why it was not allowed here",
    ];
    const menu = [...rows];
    for (let i = frame.interior.prompt; i < frame.bottom; i++) menu[i] = row(options[i - frame.interior.prompt] ?? "");
    const got = readScreen(menu, agentOf("omp"), idle);
    expect(got.cues?.strength).toBe("strong");
    expect(isFree(got.surface)).toBe(false);
    expect(got.surface.modal).not.toBe("none");
  });
});

// Issue 722: an extension keeps pi's own editor and rules and puts `❯ ` in column 0 on the first input row,
// in the border colour; the rows under it keep two columns of lead. A draft typed with newlines (`a`, then
// `Olá`) lines up like a pointed list between two rules, and the send stopped at "Enter was not pressed".
// pi's editor draws its own cursor as one reverse-video cell (pi-tui `renderFakeCursor`), and the profile
// says so (`frame.draftCaret`): rows under the glyph that hold that cell, and no option row, key hint or
// command list, are the draft's own lines. A read with no styling has no cell, so it stays a list.
describe("a newline draft under pi's column-0 prompt glyph (issue 722)", () => {
  const pi = (rows: StyledLine[]) => readScreen(rows, agentOf("pi"), idleFor("pi"));
  const row = (text: string): StyledLine => ({ segments: [{ text, style: {}, muted: false }] });
  /** The rows with every reverse-video run made plain: the same screen as a read with no cursor cell. */
  const uncursored = (rows: readonly StyledLine[]): StyledLine[] =>
    rows.map((line) => ({ segments: line.segments.map((run) => (run.inverse === true ? { text: run.text, style: {}, muted: false } : run)) }));

  // Real captures of the shape (pi 1.3.0, a repro of the reporter's editor, 140 x 40, tmux), cursor at the
  // end of the last row, and once moved up onto the prompt row.
  const DRAFTS: readonly [string, string][] = [
    ["pi--v130-quiet-prompt-two-line-draft--w140.txt", "a Olá"],
    ["pi--v130-quiet-prompt-three-line-draft--w140.txt", "a Olá tudo bem"],
    ["pi--v130-quiet-prompt-three-line-cursor-up--w140.txt", "a Olá tudo bem"],
  ];
  for (const [name, text] of DRAFTS) {
    it(`${name} reads as a draft with no modal`, () => {
      const got = pi(fixtureRows(name));
      expect(got.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
      expect(got.cues?.strength).not.toBe("strong");
      expect(got.frame?.interior.text).toBe(text);
    });

    it(`${name} with no cursor cell still reads as a list, never as free`, () => {
      const got = pi(uncursored(fixtureRows(name)));
      expect(got.cues?.strength).toBe("strong");
      expect(got.surface.modal).not.toBe("none");
      expect(isFree(got.surface)).toBe(false);
    });
  }

  // The field screen from the issue is plain text: no cell proves the editor, so it stays on the safe side.
  it("the issue's plain-text screen finds the box and stays unreadable, never free", () => {
    const rows = fixtureRows("pi--v150-gentle-quiet-two-line-draft.txt");
    expect(findInputFrame(rows, idleFor("pi")!)?.interior.text).toBe("a Olá");
    const got = pi(rows);
    expect(got.surface.modal).not.toBe("none");
    expect(isFree(got.surface)).toBe(false);
  });

  // The cell proves a focused editor only beside rows a dialog would not draw.
  const at = (name: string, needle: string): number => fixtureRows(name).findIndex((line) => rowText(line).startsWith(needle));
  const TWO = "pi--v130-quiet-prompt-two-line-draft--w140.txt";
  const LISTS: readonly [string, string][] = [
    ["a numbered row", "  2. Olá"],
    ["a checkbox row", "  [ ] Olá"],
    ["a key hint row", "  Enter to select"],
  ];
  for (const [what, text] of LISTS) {
    it(`a cursored box with ${what} under the glyph stays a list, never a draft`, () => {
      const rows = fixtureRows(TWO).map((line, i) => (i === at(TWO, "  Olá") ? { segments: [...row(text).segments, { text: " ", style: {}, muted: false, inverse: true }] } : line));
      const got = pi(rows);
      expect(got.surface.composer).not.toBe("draft");
      expect(got.surface.modal).not.toBe("none");
      expect(isFree(got.surface)).toBe(false);
    });
  }

  it("a highlighted row (a reverse-video run wider than one cell) is no cursor", () => {
    const rows = uncursored(fixtureRows(TWO)).map((line, i) =>
      i === at(TWO, "  Olá") ? { segments: [{ text: "  ", style: {}, muted: false }, { text: "Olá", style: {}, muted: false, inverse: true }] } : line,
    );
    const got = pi(rows);
    expect(got.cues?.strength).toBe("strong");
    expect(isFree(got.surface)).toBe(false);
  });

  it("two reverse-video cells are no one cursor", () => {
    const rows = fixtureRows(TWO).map((line, i) =>
      i === at(TWO, "❯ a") ? { segments: [...line.segments, { text: " ", style: {}, muted: false, inverse: true }] } : line,
    );
    const got = pi(rows);
    expect(got.cues?.strength).toBe("strong");
    expect(isFree(got.surface)).toBe(false);
  });

  // pi's own dialogs draw a search field with that same cell (the settings list): its pointer row and key
  // hint keep it a dialog.
  it("pi's settings list, with its search field's cursor cell, stays a dialog", () => {
    const got = pi(fixtureRows("pi--v130-quiet-prompt-settings--w140.txt"));
    expect(got.surface.modal).not.toBe("none");
    expect(isFree(got.surface)).toBe(false);
  });
});

// Issue 544: pi-powerline-footer replaces pi's editor (`ctx.ui.setEditorComponent`) with one that draws
// both rules and a ` > ` prompt one column in, puts its ` ↳ ` widget under the bottom rule and a
// footer of five rows under that. The pi profile reads it through its `frameAlternates` entry: every
// anchor in column one, the `>` row the prompt, the widget row as the row under the box.
describe("an extension's inset editor under pi's profile (issue 544)", () => {
  const name = "pi--v130-powerline-editor-running--w254.txt";
  const raw = readFileSync(join(PANES_DIR, name), "utf8").split("\n");
  const [TOP, PROMPT_ROW, BOTTOM] = [14, 15, 16];
  const pi = idleFor("pi")!;
  const screen = (edit: (rows: string[]) => void) => {
    const rows = [...raw];
    edit(rows);
    return readScreen(rowsOf(rows.join("\n")), "pi", pi);
  };
  const glyph = (draft: string) => ` \x1b[0m\x1b[38;2;200;200;200m>\x1b[0m${draft}`;
  const idleRule = (rows: string[]) => { rows[TOP] = rows[BOTTOM]!; };

  it("reads the captured screen as a running turn over an empty box, with no modal", () => {
    const read = own(name);
    expect(read.surface).toMatchObject({ turn: "running", modal: "none", composer: "empty" });
    expect(read.frame).toMatchObject({ top: TOP, bottom: BOTTOM, label: "⠸ Working" });
  });

  it("reads the same box free once the turn ends, and a typed draft as a draft", () => {
    expect(isFree(screen(idleRule).surface)).toBe(true);
    const draft = screen((r) => { idleRule(r); r[PROMPT_ROW] = glyph(" hello from the probe"); });
    expect(draft.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
    expect(draft.frame!.interior.text).toBe("hello from the probe");
  });

  it.each([
    ["a top rule in column zero", (r: string[]) => { r[TOP] = `${r[BOTTOM]!.slice(1)} `; }],
    ["a bottom rule in column zero", (r: string[]) => { idleRule(r); r[BOTTOM] = `${r[BOTTOM]!.slice(1)} `; }],
    ["the prompt in column zero", (r: string[]) => { idleRule(r); r[PROMPT_ROW] = r[PROMPT_ROW]!.slice(1); }],
    ["the whole frame two columns in", (r: string[]) => { idleRule(r); for (const i of [TOP, PROMPT_ROW, BOTTOM]) r[i] = ` ${r[i]!}`; }],
    ["the bash-mode `$` glyph", (r: string[]) => { idleRule(r); r[PROMPT_ROW] = ` \x1b[38;2;200;200;200m$\x1b[0m ls`; }],
    ["a numbered list behind the glyph", (r: string[]) => { idleRule(r); r[PROMPT_ROW] = glyph(" 1. Red"); r.splice(BOTTOM, 0, "   2. Green", "   3. Blue"); }],
    ["another row under the box", (r: string[]) => { idleRule(r); r[BOTTOM + 1] = " Enter to submit • Esc to go back"; }],
  ])("never reads free with %s", (_name, edit) => {
    const read = screen(edit);
    expect(isFree(read.surface)).toBe(false);
    expect(read.surface.modal === "none" && read.surface.composer === "empty").toBe(false);
  });
});

// Issue 544, live (pi 1.3.0 and pi-powerline-footer 0.20.2, 2026-10-20): with no footer of another
// extension the inset box ends the screen, or its ` ↳ ` widget row does. A draft that wraps, and every
// walky talky message (its header row, then its body row), puts rows three spaces in under the ` >`
// row. The generic cues read the box rows on pi (`dialogsInBox`), and there the glyph and a row in the
// hole's column looked like a pointed list between two rules: modal unreadable, every such send
// refused. The alternate names the glyph as the box's own (`ownPrompt`) beside a `rows` pattern, so a
// box with any other row inside finds no frame at all.
describe("an extension's inset editor, live (issue 544)", () => {
  const pi = idleFor("pi")!;
  const DRAFTS: readonly [string, string][] = [
    ["pi--v130-powerline-editor-two-row-draft--w120.txt", 'Use the question tool exactly once: ask "Which fruit do you like?" with the options Apple, Banana, Cherry. Do nothing else.'],
    ["pi--v130-powerline-editor-walky-draft--w120.txt", "[walky-talky wt_0a1b2c3d4e5f] from operator (Phone) Reply with exactly WALKY-1 and nothing else."],
  ];
  const lines = (name: string): string[] => readFileSync(join(PANES_DIR, name), "utf8").split("\n");
  const read = (rows: string[]) => readScreen(rowsOf(rows.join("\n")), "pi", pi);
  // eslint-disable-next-line no-control-regex
  const PROMPT = /^ \u001b\[38;2;200;200;200m>/u;
  /** The two-row draft with its rows inside the box changed. */
  const twoRow = (edit: (rows: string[], prompt: number) => void): string[] => {
    const rows = lines(DRAFTS[0]![0]);
    const prompt = rows.findIndex((row) => PROMPT.test(row));
    edit(rows, prompt);
    return rows;
  };

  it.each(DRAFTS)("%s reads as one draft with no modal", (name, text) => {
    const found = own(name);
    expect(found.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
    expect(found.frame!.interior.text).toBe(text);
    expect(found.frame!.ownPrompt).toEqual({ row: found.frame!.interior.prompt, end: 3 });
  });

  it("reads the empty box over its widget row free, and pi's /model selector never", () => {
    expect(isFree(own("pi--v130-powerline-editor-idle-widget--w120.txt").surface)).toBe(true);
    expect(own("pi--v130-powerline-model-selector--w120.txt").surface).toMatchObject({ modal: "unreadable", composer: "unknown" });
  });

  it("names the glyph on the inset box only: the column-zero box has none", () => {
    expect(own("pi--v130-slash-model-list--w120.txt").frame?.ownPrompt).toBeUndefined();
    // An empty box has no hole: the whole prompt row is the glyph.
    expect(own("pi--v130-powerline-editor-running--w254.txt").frame?.ownPrompt).toEqual({ row: 15, end: 254 });
  });

  it.each([
    ["a row one column in", (r: string[], p: number) => r.splice(p + 1, 0, " 2. Green")],
    ["a row two columns in", (r: string[], p: number) => r.splice(p + 1, 0, "  2. Green")],
    ["a pointer row inside", (r: string[], p: number) => r.splice(p + 1, 0, " → Apple")],
    ["a second prompt row", (r: string[], p: number) => r.splice(p + 1, 0, ` \u001b[38;2;200;200;200m>\u001b[39m Banana`)],
    ["a row in column zero", (r: string[], p: number) => r.splice(p + 1, 0, "Which fruit?")],
  ])("finds no box with %s, so the read is never free", (_name, edit) => {
    const found = read(twoRow(edit));
    expect(found.frame).toBeNull();
    expect(isFree(found.surface)).toBe(false);
  });

  it("still reads a dialog's key hints inside the box as a modal", () => {
    const found = read(twoRow((r, p) => r.splice(p + 1, 1, "   ↑↓ navigate • Enter to select • Esc to cancel")));
    expect(found.surface.modal).toBe("unreadable");
    expect(isFree(found.surface)).toBe(false);
  });

  // The slash list opens under the inset box as under pi's own (the editor draws it, the widget comes
  // after): the alternate shares the profile's `commandList`, and its footer takes the widget row.
  it("reads /model typed over its own list as a draft, with the widget row and a footer under the list too", () => {
    const name = "pi--v130-powerline-editor-slash-model--w120.txt";
    const rows = lines(name);
    const widget = " \u001b[38;5;244m↳\u001b[39m \u001b[38;5;244mReply with exactly DONE-1 and nothing else.\u001b[39m";
    const footer = ["\u001b[38;2;126;136;142m~/project (main)\u001b[39m", "\u001b[38;2;126;136;142m↑9 ↓28 $0.012\u001b[39m", "\u001b[38;2;126;136;142mSystem ok\u001b[39m", "\u001b[38;2;126;136;142mEstimated 2k\u001b[39m", "⏱ 3.5s"];
    for (const under of [[], [widget], [widget, ...footer]]) {
      const screen = [...rows.slice(under.length), ...under];
      const found = read(screen);
      expect(found.surface, String(under.length)).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
      expect(found.frame!.interior.text).toBe("/model");
      const styled = rowsOf(screen.join("\n"));
      expect(ownCommandList(styled.map(rowText), found.frame, pi, styled)).toMatchObject({ pointed: "/model", side: "under" });
    }
  });
});

// Issue 544, the reporter's two idle captures (pi 1.3.0, 254 columns): the turn is done, the box stands
// over the ` ↳ ` widget row, whose long text is cut by an ellipsis, and under it a five-row footer whose
// cwd row the widget's second line has overwritten. The idle box is free, and a two-row draft reads back
// as the rows joined by a space, with no modal.
describe("the reporter's idle captures under pi-powerline-footer (issue 544)", () => {
  it("reads the empty box free: idle, no modal", () => {
    const read = own("pi--v130-powerline-editor-idle-footer--w254.txt");
    expect(read.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    expect(isFree(read.surface)).toBe(true);
  });

  it("reads the two typed rows as one draft, not free, no modal", () => {
    const read = own("pi--v130-powerline-editor-two-row-draft-footer--w254.txt");
    expect(read.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
    expect(read.frame!.interior.text).toBe("Collie test draft line one Collie test draft line two");
    expect(isFree(read.surface)).toBe(false);
  });
});

// omp 18.6.1 and 18.12.6 (omp-gang testers, 2026-10-25). The fuzzy list under the box is up to ten rows
// tall and points at a command that is not the typed one. Until 1.24.1 the box past it was found only for a
// list that pointed at the typed text, so these screens read `unreadable/torn` and the phone's `/help`,
// `/mo` and `/nothere` ended `typed_not_submitted (modal_cue)` with the generic detail. The profile's
// `leadOpens` makes the list the typed text's own popup: the Surface reads a draft and no modal, and
// the Send Protocol alone decides, from the pointer, whether Enter runs what is typed.
// Issue 638 (pi 1.4.0 on Herdr, mode=command): pi draws a fuzzy list under the box for a text that starts
// with `/`, on 1.3.0 and 1.4.0 alike: `/s` lists five rows and a `(1/8)` count, the pointer on `settings`;
// `/model haiku` lists the models that match the argument, the pointer on the first. Until the pi profile
// named `leadOpens`, these screens read `unreadable`, the send ended `typed_not_submitted (modal_cue)` with
// the generic detail, and every later send on the pane was refused `unconfirmed` until a person pressed
// Escape in the terminal. Now the Surface reads a draft and no modal; Enter still waits, because the
// pointer is not on the typed text, and the next send finds the person's draft.
describe("pi's fuzzy command list under the box (issue 638, pi 1.3.0 and 1.4.0)", () => {
  const FUZZY: readonly [string, string, string][] = [
    ["pi--v130-slash-mod-partial--w120.txt", "/mod", "/model"],
    ["pi--v140-slash-s-fuzzy--w120.txt", "/s", "/settings"],
    ["pi--v140-slash-model-arg-list--w120.txt", "/model haiku", "/anthropic/claude-haiku-4.5"],
  ];

  for (const [name, typed, pointed] of FUZZY) {
    it(`${name}: a draft with no modal and the list read, pointed at ${pointed}`, () => {
      const read = own(name);
      expect(read.frame?.interior.text).toBe(typed);
      expect(read.surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "draft" });
      expect(read.cues?.strength).toBe("none");
      expect(labelOf(name).state).toBe("popup");
      const idle = idleFor("pi")!;
      const texts = fixtureRows(name).map(rowText);
      const list = commandListAt(texts, read.frame!, idle.volatile.below.commandList);
      expect(list?.pointed, name).toBe(pointed);
      expect(pointsAt(list!, typed, idle.volatile.below.commandList), name).toBe(false);
    });
  }

  // A `/` alone with pi's whole palette under it is the person's draft too, not a dialog.
  for (const name of ["pi--v110-slash-palette.txt", "pi--v120-slash-palette-padded.txt"]) {
    it(`${name}: \`/\` with the palette open reads a draft with no modal`, () => {
      const read = own(name);
      expect(read.frame?.interior.text).toBe("/");
      expect(read.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
      expect(labelOf(name).state).toBe("popup");
    });
  }
});

describe("omp's fuzzy command list under the box (18.6.1 and 18.12.6)", () => {
  const FUZZY: readonly [string, string, string][] = [
    ["omp--v18-6-1-slash-open-tall--w120.txt", "/", "/skill:"],
    ["omp--v18-6-1-slash-help-unlisted--w120.txt", "/help", "/plan-review"],
    ["omp--v18-6-1-slash-mo-fuzzy--w120.txt", "/mo", "/model"],
    ["omp--v18-6-1-slash-nothere-fuzzy--w120.txt", "/nothere", "/skills"],
    ["omp--v18-12-6-slash-help-unlisted--w120.txt", "/help", "/plan-review"],
    ["omp--v18-12-6-slash-mo-fuzzy--w120.txt", "/mo", "/model"],
    ["omp--v18-12-6-slash-nothere-fuzzy--w120.txt", "/nothere", "/skills"],
    ["omp--v18-12-6-slash-comment-loop-row--w120.txt", "//comment", "/loop"],
  ];

  for (const [name, typed, pointed] of FUZZY) {
    it(`${name}: a draft with no modal and the list read, pointed at ${pointed}`, () => {
      const read = own(name);
      expect(read.frame?.interior.text).toBe(typed);
      expect(read.surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "draft" });
      expect(read.cues?.strength).toBe("none");
      expect(labelOf(name).state).toBe("popup");
      const idle = idleFor("omp")!;
      const texts = fixtureRows(name).map(rowText);
      const list = commandListAt(texts, read.frame!, idle.volatile.below.commandList);
      expect(list?.pointed, name).toBe(pointed);
      expect(pointsAt(list!, typed, idle.volatile.below.commandList), name).toBe(false);
    });
  }

  // The 18.12.6 row that stays under the box after a cancelled `//comment`: the Surface already read it free.
  it("omp--v18-12-6-stale-list-row-empty-box--w120.txt: an empty box and no modal, with the stale row still read as a list", () => {
    const name = "omp--v18-12-6-stale-list-row-empty-box--w120.txt";
    const read = own(name);
    expect(read.surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "empty" });
    expect(labelOf(name).state).toBe("idle");
    const texts = fixtureRows(name).map(rowText);
    expect(commandListAt(texts, read.frame!, idleFor("omp")!.volatile.below.commandList)?.pointed).toBe("/loop");
  });

  // A box past a list the profile does not call fuzzy (`leadOpens`) is found only when the pointer rests on its text.
});

// omp 18.6.1 and 18.12.6 (omp-gang testers 05 and 12, 2026-10-25). A file path at the start of the box makes
// omp draw its file popup under it, one `❯ name.png` row. The profile's patterns took that row for a command
// list pointing at another command, and the phone's send of an upload path ended `typed_not_submitted
// (modal_cue)` with nothing wrong. `commandList.notForText` says such a text opens no command list: the
// Surface still reads a draft and no modal, and no list is read.
describe("omp's file popup under a path typed in the box (18.6.1 and 18.12.6)", () => {
  const POPUPS: readonly [string, string][] = [
    ["omp--v18-6-1-path-popup--w120.txt", "/home/demo/lab1/.cache/collie-lab/omp-gang/05-images/state/rig/state/uploads/w2_p1-mvo3m20o-6e1a9e71.png"],
    ["omp--v18-6-1-path-popup-tilde--w120.txt", "~/.cache/collie-lab/omp-gang/12-pickers/state/harness/omp/project/x.png"],
    ["omp--v18-12-6-path-popup--w120.txt", "/home/demo/lab1/.cache/collie-lab/omp-gang/05-images/state/rig/state/uploads/w2_p1-mvo44h6i-fd050f5a.png"],
    // Two upload paths on two rows: the draft's rows join into one text that starts with a path.
    ["omp--v18-12-6-path-popup-two-paths--w120.txt", ""],
  ];

  for (const [name, typed] of POPUPS) {
    it(`${name}: a draft with no modal, no cue and no command list`, () => {
      const read = own(name);
      if (typed !== "") expect(read.frame?.interior.text).toBe(typed);
      else expect(read.frame?.interior.text).toMatch(/^\/home\/demo\/lab1\/.*\.png\s*\/home\/demo\/lab1\/.*\.png$/u);
      expect(read.surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "draft" });
      expect(read.cues?.strength).toBe("none");
      expect(labelOf(name).state).toBe("popup");
      const idle = idleFor("omp")!;
      const texts = fixtureRows(name).map(rowText);
      expect(commandListAt(texts, read.frame!, idle.volatile.below.commandList), name).toBeNull();
    });
  }
});

// The ascii symbol preset draws every cursor as `>` (omp-gang 11-geometry, W3). The pointer pattern reads that glyph in a
// command list, and a popup row under a typed path must still be no command list: `notForText` decides on the text.
describe("omp's file popup with the ascii cursor under a typed path is still no command list", () => {
  for (const name of ["omp--v18-6-1-path-popup--w120.txt", "omp--v18-12-6-path-popup--w120.txt", "omp--v18-6-1-path-popup-tilde--w120.txt"]) {
    it(`${name}: the popup row drawn with > reads a draft, no cue, no command list`, () => {
      const rows = rowsOf(fixtureRows(name).map(rowText).map((text) => text.replace(/^❯ /u, "> ")).join("\n"));
      const read = readScreen(rows, "omp", idleFor("omp"));
      expect(read.surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "draft" });
      expect(read.cues?.strength).toBe("none");
      const texts = rows.map(rowText);
      expect(texts.some((text) => text.startsWith("> ")), name).toBe(true);
      expect(commandListAt(texts, read.frame!, idleFor("omp")!.volatile.below.commandList), name).toBeNull();
    });
  }
});

describe("omp's status row pattern leaves the rows under a command list alone", () => {
  // The rows an extension draws under a list (`commandList.footer`) and the popup rows are under the box. Neither may read
  // as the status row over a box, or a box above them would be found a second time from there.
  it("no row under the box of the status-row palettes and the popups is a status row", () => {
    const top = new RegExp(idleFor("omp")!.frame.top.pattern, "u");
    for (const name of ["omp--v18-12-6-status-row-palette-4.txt", "omp--v18-6-1-status-row-palette-4.txt", "omp--v18-12-6-status-row-palette-10.txt", "omp--v18-6-1-at-popup--w120.txt", "omp--v18-6-1-hash-popup--w120.txt", "omp--v18-6-1-path-popup--w120.txt"]) {
      const rows = fixtureRows(name, name.includes("status-row") ? SURFACE_FIXTURES_DIR : PANES_DIR);
      const frame = findInputFrame(rows, idleFor("omp")!)!;
      const under = rows.map(rowText).slice(frame.bottom + 1).filter((text) => text.trim() !== "");
      expect(under.length, name).toBeGreaterThan(0);
      for (const text of under) expect(top.test(text), `${name}: ${text}`).toBe(false);
    }
  });
});

describe("omp's rewind picker (Esc Esc) is a modal, not an unknown screen (18.6.1 and 18.12.6)", () => {
  const PICKERS = ["omp--v18-6-1-rewind-picker--w120.txt", "omp--v18-12-6-rewind-picker--w120.txt"];

  for (const name of PICKERS) {
    it(`${name}: no frame, modal unreadable from the footer the profile names`, () => {
      const read = own(name);
      expect(read.frame).toBeNull();
      expect(read.cues?.strength).toBe("weak");
      expect(read.surface).toEqual({ revision: 1, turn: "unknown", modal: "unreadable", composer: "unknown" });
    });

    it(`${name}: without the footer row the same screen stays unknown, so the footer is the cue`, () => {
      const rows = fixtureRows(name);
      const footer = rows.findIndex((row) => /rewind/.test(rowText(row)));
      expect(footer).toBeGreaterThan(0);
      const changed = rows.map((row, i) => (i === footer ? { segments: [{ text: " 29/29  ↑/↓ step  ←/→ user turns  f filter  ⏎ go  Ctrl+O expand  ⎋ cancel" }] } : row));
      // SAFETY: `changed` is `rows` with one row replaced by a one-segment row of the same shape.
      expect(readScreen(changed as typeof rows, agentOf("omp"), idleFor("omp")).surface.modal).toBe("unknown");
    });
  }
});

describe("omp's typeahead popups under the box read as a draft (18.6.1, omp-gang tester 12)", () => {
  const DRAFTS: readonly [string, string][] = [
    ["omp--v18-6-1-at-popup--w120.txt", "please read @READ"],
    ["omp--v18-6-1-at-popup-path--w120.txt", "@/tmp/x.png"],
    ["omp--v18-6-1-hash-popup--w120.txt", "fix item #1"],
    ["omp--v18-6-1-hash-popup-single--w120.txt", "see PR #12"],
    // omp-gang 04-readers (2026-10-26): the first real captures of the emoji popup (one space after the glyph)
    // and of the one-row popup under a partial path.
    ["omp--v18-12-6-emoji-popup--w120.txt", "hello :smi"],
    ["omp--v18-6-1-emoji-popup--w120.txt", "hello :smi"],
    // omp-gang three (2026-10-26): a text ending in a bare `#` draws omp's seven-row editor-action list.
    ["omp--v18-12-6-hash-end-actions--w120.txt", "ends with hash #"],
    ["omp--v18-6-1-hash-end-actions--w120.txt", "ends with hash #"],
    ["omp--v18-12-6-path-popup-partial--w120.txt", "~/.cache/collie-lab/omp-gang/gang3/04-readers/state/harness/omp/project/src/ma"],
  ];

  for (const [name, typed] of DRAFTS) {
    it(`${name}: a draft with no modal and no cue`, () => {
      const read = own(name);
      expect(read.frame?.interior.text).toBe(typed);
      expect(read.surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "draft" });
      expect(read.cues?.strength).toBe("none");
      expect(labelOf(name).state).toBe("popup");
    });
  }

  it("the `#` popup is two rows with a pointer, the weak cue that read `modal: unknown` before the profile named it", () => {
    const name = "omp--v18-6-1-hash-popup--w120.txt";
    const idle = idleFor("omp")!;
    const { popups, ...below } = idle.volatile.below;
    void popups;
    const without = readScreen(fixtureRows(name), agentOf("omp"), { ...idle, volatile: { ...idle.volatile, below } });
    expect(without.cues?.strength).toBe("weak");
    expect(without.surface.modal).toBe("unknown");
  });

  it("omp--v18-6-1-hash-popup-stale--w120.txt: the `#` rows left under an emptied box are a stale popup, an empty box", () => {
    const read = own("omp--v18-6-1-hash-popup-stale--w120.txt");
    expect(read.frame?.interior.text).toBe("");
    expect(read.surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "empty" });
    expect(read.cues?.strength).toBe("none");
  });

  it("omp--v18-6-1-at-popup-stale--w120.txt: the `@` rows left under an emptied box are a stale popup, an empty box (the file rule names staleWhenEmpty)", () => {
    const name = "omp--v18-6-1-at-popup-stale--w120.txt";
    const read = own(name);
    expect(read.frame?.interior.text).toBe("");
    expect(read.surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "empty" });
    expect(read.cues?.strength).toBe("none");
    expect(labelOf(name).state).toBe("popup");
  });

  it("the emoji popup with the old two-space row pattern is no popup: the eight rows read as a pointer list, unreadable", () => {
    const name = "omp--v18-12-6-emoji-popup--w120.txt";
    const idle = idleFor("omp")!;
    const popups = idle.volatile.below.popups!;
    const rules = popups.rules.map((rule) => (rule.name === "emoji" ? { ...rule, rows: rule.rows.replace(" {1,2}", " {2}") } : rule));
    const read = readScreen(fixtureRows(name), agentOf("omp"), { ...idle, volatile: { ...idle.volatile, below: { ...idle.volatile.below, popups: { ...popups, rules } } } });
    expect(read.cues?.strength).toBe("strong");
    expect(read.surface.modal).toBe("unreadable");
  });

  it("the editor-action list stands under a box only while the text ends in a bare `#`: seven rows are a popup of that word and nothing else", () => {
    const name = "omp--v18-6-1-hash-end-actions--w120.txt";
    const texts = fixtureRows(name).map((row) => rowText(row));
    const typed = (text: string): string => texts.map((row) => (row.startsWith("╰─") ? `╰─ ${text}` : row)).join("\n");
    const open = readScreen(rowsOf(typed("ends with hash #")), agentOf("omp"), idleFor("omp"));
    expect(open.surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "draft" });
    expect(open.cues?.strength).toBe("none");
    for (const text of ["ends with a word", "ends with hash # and more"]) {
      const closed = readScreen(rowsOf(typed(text)), agentOf("omp"), idleFor("omp"));
      expect(closed.surface.modal, text).not.toBe("none");
    }
  });

  it("a dialog drawn under the box is not a popup: the same box over a permission row stays a modal", () => {
    const name = "omp--v18-6-1-hash-popup--w120.txt";
    const rows = fixtureRows(name);
    const dialog = [...rows, ...rowsOf("  Allow tool: bash\n  ❯ Approve\n    Deny")];
    const read = readScreen(dialog, agentOf("omp"), idleFor("omp"));
    expect(read.surface.modal).not.toBe("none");
  });
});

// omp-gang three, 01-regression W1 (2026-10-26), omp 18.6.1 and 18.12.6: a draft that holds a pasted box drawing
// (`│ ❯ Approve   │`). omp's box has no right border here, but the profile cut a trailing `│` or `╯` off every
// row, so the read text lacked the glyphs that closed the quoted rows. A glyph with padding after it is the
// person's text; a glyph at the row's last cell is the box's own border (the nerd-box captures at 80 columns).
describe("a pasted box drawing in the draft keeps the glyphs that close its rows (omp-gang three W1)", () => {
  const NAMES = ["omp--v18-6-1-quoted-box-draft--w120.txt", "omp--v18-12-6-quoted-box-draft--w120.txt"];
  const TYPED = "Here is what omp showed me: ╭─ Allow tool: bash ───────────╮ │ ❯ Approve                    │ │   Deny                       │ ╰──────────────────────────────╯ why did it ask?";
  const read = (name: string, rows?: StyledLine[]) => readScreen(rows ?? fixtureRows(name, SURFACE_FIXTURES_DIR), agentOf("omp"), idleFor("omp"));

  it.each(NAMES)("%s: the box text is the typed text, to the last glyph, and the screen reads a draft", (name) => {
    const r = read(name);
    expect(r.frame?.interior.text).toBe(TYPED);
    expect(r.surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "draft" });
    expect(r.cues?.strength).toBe("none");
  });

  it("a read that cut the trailing spaces cannot tell a border from the person's glyph, and cuts it as before", () => {
    const rows = rowsOf(fixtureRows(NAMES[0]!, SURFACE_FIXTURES_DIR).map((row) => rowText(row).trimEnd()).join("\n"));
    expect(read(NAMES[0]!, rows).frame?.interior.text).toBe("Here is what omp showed me: ╭─ Allow tool: bash ───────────╮ │ ❯ Approve │   Deny ╰───────────────────────────── why did it ask?");
  });

  it("the box's own right border at the last cell is still no part of the draft (omp's nerd box at 80 columns)", () => {
    const r = readScreen(fixtureRows("omp--v18-11-nerd-box-two-lines--w80.txt"), agentOf("omp"), idleFor("omp"));
    expect(r.frame?.interior.text).toBe("First line of a two-line draft. Second line of the same draft.");
  });
});

describe("a dialog quoted inside the person's own draft is the draft's text (omp 18.6.1, omp-gang tester 12)", () => {
  const NAME = "omp--v18-6-1-quoted-dialog-draft--w120.txt";

  it("a nine-row prompt that prints a permission box inside a code fence reads a draft, no cue", () => {
    const read = own(NAME);
    expect(read.frame?.interior.text).toContain("╭─ Allow tool: bash ───────────╮ │ ❯ Approve");
    expect(read.surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "draft" });
    expect(read.cues?.strength).toBe("none");
    expect(labelOf(NAME).state).toBe("draft");
  });

  it("the profile's draftIndent is what says so: without it the same screen is a modal nobody can read", () => {
    const idle = idleFor("omp")!;
    const { draftIndent, ...frame } = idle.frame;
    void draftIndent;
    const read = readScreen(fixtureRows(NAME), agentOf("omp"), { ...idle, frame });
    expect(read.cues?.strength).toBe("strong");
    expect(read.surface.modal).toBe("unreadable");
  });

  it("the same rows at the box's own column are a dialog drawn in the box's place, and stay one", () => {
    const rows = fixtureRows(NAME).map((row) => rowText(row));
    const outdented = rows.map((text) => (/^ {3}[╭│╰]/u.test(text) ? text.slice(3) : text)).join("\n");
    const read = readScreen(rowsOf(outdented), agentOf("omp"), idleFor("omp"));
    expect(read.surface.modal).toBe("unreadable");
  });
});

const STATUS_ROW_FIXTURES = [
  "omp--v18-12-6-status-ascii-draft--w80.txt",
  "omp--v18-12-6-status-ascii-idle--w130.txt",
  "omp--v18-12-6-status-full-slash-draft--w80.txt",
  "omp--v18-12-6-status-full-slash-idle--w80.txt",
  "omp--v18-6-1-status-ascii-idle--w80.txt",
  "omp--v18-6-1-status-full-slash-idle--w80.txt",
];

describe("omp's status row above the box, in every shape its presets draw (omp-gang 11-geometry, 2026-10-25)", () => {
  // Rows rendered by OMP 18.12.6's own status line (pi-tui status-line, the gallery's fake session) across the presets
  // default, minimal, compact, full, nerd and ascii, the separators and the symbol presets, at widths from 20 to 130.
  // Until 1.24.1 the profile asked for a run of three rule glyphs, so the full preset at 80 columns (its gauge shrinks
  // to ─5%─┃200K─) and the ascii preset (first token [high], [M] or [T]) read as no box: unknown, and a send refused.
  const STATUS_ROW_SAMPLES: readonly (readonly [string, string])[] = [
  ["percentage and tick gauge, 130 columns", " π > ⬢ test-model > 🗑 geo2-render > ◫ 0.8%/200K ⟲ > $0.02 ▶───────────────────────────────────────────────────────────────────────"],
  ["full preset, embedded gauge down to its percent label", " π / 🖥 example / ⬢ test-model / 🗑 geo2-render ─0.8%────200K─ 💾 20.00% / ⤵ 1.2K "],
  ["full preset, powerline caps, labels kept", " π ▶ 🖥 example ▶ ⬢ test-model ▶ 🗑 geo2-render ▶──30%───200K─"],
  ["minimal preset, the path first", " 🗑 geo2-render ─────────30%──────────────────200K─"],
  ["compact preset, pipe separator, plain rule", " ⬢ test-model ─────────────────────── $0.02 │ ◫ 0.0%/200K ⟲ "],
  ["overflow: window label before the percent", " π ▶ 🗑 …ender ▶──────200K─125%"],
  ["ascii symbols, percent label between dashes", " pi > [T] …der >-----95%-200K-"],
  ["ascii preset, [M] first", " [M] test-model > [T] geo2-render -0.8%-------------------200K- tok: 2K < $0.02 "],
  ["ascii compact, a short rule", " [M] test-model >---"],
  ["ascii minimal, [T] path first", " [T] geo2-render >-----------------------------------------< ctx: 0.0%/200K [A] "],
  ["nerd full preset, labels kept", " \u{F0D57} \u{E0B0} \u{F109} example \u{E0B0} \u{EC19} test-model \u{E0B0} \u{F014} geo2-render \u{E0B0}─0.8%───200K─\u{E0B2} \u{F1C0} 20.00% \u{E0B2} \u{F090} 1.2K "],
  ["nerd preset", " \u{F0D57} \u{E0B0} \u{F109} example \u{E0B0} \u{EC19} test-model \u{E0B0} \u{F014} geo2-render \u{E0B0} \u{F0051} new \u{E0B0}────────────\u{E0B2} \u{F090} 1.2K \u{E0B2} \u{F08B} 800 \u{E0B2} \u{F1C0} 300 \u{E0B2} $0.02 "],
  ["block separator", " 🗑 geo2-render ──────────────────── ◫ 0.0%/200K ⟲ "],
  ["two rule glyphs at the end, powerline caps", " π ▶ ⬢ test-model ▶ 🗑 geo2-render ▶ ◫ 0.0%/200K ⟲ ▶ $0.02 ──"],
  ["one rule glyph after a cap", " π ▶ ⬢ test-model ▶ 🗑 …ender ▶─"],
  ["ascii, one rule glyph after a cap", " pi > [M] test-model > [T] geo2-render > ctx: 0.0%/200K [A] > $0.02 >-"],
  ["one rule glyph set apart by spaces", " ⬢ test-model ─ $0.02 ◀ ◫ 125.0%/200K ⟲ "],
  ["a named profile on the brand", " π-work ▶ ⬢ test-model ▶ 🗑 geo2-render ▶──30%───200K─"],
  ];
  const screen = (status: string, box: string): StyledLine[] => rowsOf(["", status, `╰─ ${box}`.trimEnd()].join("\n"));
  const idle = idleFor("omp");

  for (const [label, row] of STATUS_ROW_SAMPLES) {
    it(`${label}: an empty box and a draft are read`, () => {
      expect(readScreen(screen(row, ""), "omp", idle).surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "empty" });
      const draft = readScreen(screen(row, "abc"), "omp", idle);
      expect(draft.surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "draft" });
      expect(draft.frame?.interior.text).toBe("abc");
    });
  }

  // While a turn runs the brand glyph is the spinner and the turn timer; the ascii preset spins - \\ | /.
  const RUNNING: readonly (readonly [string, string])[] = [
    ["unicode spinner", " ⠼ 4s ▶ ⬢ test-model ▶ 🗑 geo2-render ▶──30%───200K─"],
    ["unicode spinner, slash separator, short gauge", " ⠼ 4s / ⬢ test-model / 🗑 geo2-render ─30%─200K─"],
    ["ascii spinner", " \\ 4s > [M] test-model > [T] geo2-render >-----95%-200K-"],
    ["ascii spinner, a minute", " | 1m > [M] test-model >---"],
  ];
  for (const [label, row] of RUNNING) {
    it(`${label}: a running turn is read`, () => {
      expect(readScreen(screen(row, ""), "omp", idle).surface).toEqual({ revision: 1, turn: "running", modal: "none", composer: "empty" });
    });
  }

  // Prose that holds three dashes is not a status row: with no status row over the box there is no box.
  it("a transcript line with dashes over the box is no status row", () => {
    for (const line of ["Use --- as a rule", "See the list ─── below", "Note: 5% then 200K - done"]) {
      const read = readScreen(rowsOf([line, "", "╰─ abc"].join("\n")), "omp", idle);
      expect(read.frame, line).toBeNull();
      expect(isFree(read.surface), line).toBe(false);
    }
  });

  for (const name of STATUS_ROW_FIXTURES) {
    it(`${name}: the captured screen reads ${labelOf(name).state}`, () => {
      const read = own(name);
      const want = labelOf(name).state === "draft" ? { composer: "draft", text: "abc" } : { composer: "empty", text: "" };
      expect(read.surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: want.composer });
      expect(read.frame?.interior.text).toBe(want.text);
      expect(read.cues?.strength).toBe("none");
    });
  }
});

// omp 18.12.6 draws the editor in one of eight `composer.shape` forms (omp-gang 11-geometry W5, 2026-10-25):
// band, borderless, claude, field, pi, rail, rule and the default box. The profile lists the box and the shapes
// `frameAlternates` already held (claude rules, pi's blank row); `field` is a borderless run of ▐ rows closed by ▌.
describe("omp's composer.shape field (18.12.6)", () => {
  const FIELD = ["omp--v18-12-6-composer-field-idle--w130.txt", "omp--v18-12-6-composer-field-two-lines--w130.txt"];
  const idle = idleFor("omp");

  it("the empty field box reads an idle, empty composer, and the hint inside it is no draft", () => {
    const read = readScreen(fixtureRows(FIELD[0]!), "omp", idle);
    expect(read.surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "empty" });
    expect(read.frame?.interior.text).toBe("");
    expect(read.cues?.strength).toBe("none");
    expect(labelOf(FIELD[0]!).state).toBe("idle");
  });

  it("a two-line draft reads as the two lines joined, with no modal", () => {
    const read = readScreen(fixtureRows(FIELD[1]!), "omp", idle);
    expect(read.surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "draft" });
    expect(read.frame?.interior.text).toBe("draft line 1: the quick brown fox jumps over the lazy dog 1 draft line 2: the quick brown fox jumps over the lazy dog 2");
    expect(labelOf(FIELD[1]!).state).toBe("draft");
  });

  it("a transcript line that opens with the block glyph is no field box without a blank row above it", () => {
    const rows = rowsOf(["some output", "▐ quoted text ▌", "", " π · ◒ Haiku 4.5 · 📁 ~/work · ◫ 4.7%/200K ⟲ "].join("\n"));
    expect(readScreen(rows, "omp", idle).surface.composer).not.toBe("draft");
  });

  // `composer.shape: claude` draws the Claude Code frame (rule, `❯`, rule) under a status row. A one-line draft
  // and the empty box read. A two-line draft does not: the prompt row and the indented row under it are a
  // pointer row on a listed row between two rules, which the cue reader takes for a dialog (cues, `pointer-row`).
  // `idle.dialogsInBox`'s answer for a harness is `ownPrompt`, but it is only safe on the interior walk with a
  // `rows` pattern naming every row a box may hold, and this alternate walks the edges: with `ownPrompt` any
  // `❯` list between two rules would read as a draft. A fix needs a walk that names the rows (rule, `❯` row,
  // two-space rows, status row), which collides with Claude Code's own `❯` pickers on the same screens.
  const CLAUDE_TWO_LINES = [
    "──────────────────────────────────────────────────────────────────────────────",
    "❯ draft line 1: the quick brown fox jumps over the lazy dog 1",
    "  draft line 2: the quick brown fox jumps over the lazy dog 2",
    "──────────────────────────────────────────────────────────────────────────────",
    " π · ◒ Haiku 4.5 · 📁 ~/work · ◫ 4.7%/200K ⟲ ",
  ];
  it.todo("composer.shape claude: a two-line draft reads as a draft, not an unreadable modal (see the note above)");
  it.fails("composer.shape claude, two-line draft: the wanted read, which the cue reader still refuses", () => {
    const read = readScreen(rowsOf(CLAUDE_TWO_LINES.join("\n")), "omp", idle);
    expect(read.surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "draft" });
  });
});

// omp 18.6.1 and 18.12.6 (omp-gang three, tester 5, 2026-10-26, W3): a local shell line typed with `!`
// (`!sleep 25`) runs in omp's own bash block, `$ sleep 25` and `⠋ Running… (⎋ to cancel)` between two rules,
// and no model turn is on. The profile's running rows knew only `Working…`, so the Surface read the turn idle
// and the phone's Stop was refused `turn_idle` for a command that only Escape ends. The row says Escape on
// its face (`⎋ to cancel`), the profile's interrupt key.
describe("omp's local shell line that is running (18.6.1 and 18.12.6)", () => {
  const RUNNING = ["omp--v18-6-1-local-bash-running--w120.txt", "omp--v18-12-6-local-bash-running--w120.txt"] as const;

  for (const name of RUNNING) {
    it(`${name}: the turn reads running, the box empty and no modal`, () => {
      const rows = fixtureRows(name, SURFACE_FIXTURES_DIR);
      const read = readScreen(rows, "omp", idleFor("omp"));
      expect(read.surface).toEqual({ revision: 1, turn: "running", modal: "none", composer: "empty" });
      expect(runningSign(rows, read.frame!, idleFor("omp")!.runningRows)).toBe(true);
    });

    it(`${name}: without the Running row the same screen reads idle`, () => {
      const rows = fixtureRows(name, SURFACE_FIXTURES_DIR).map((row) => (rowText(row).includes("Running…") ? { segments: [] } : row));
      expect(readScreen(rows, "omp", idleFor("omp")).surface.turn).toBe("idle");
    });
  }

  it("the row's pattern is the spinner and the cancel hint, not the word Running alone", () => {
    const idle = idleFor("omp")!;
    const sign = (text: string): boolean => idle.runningRows!.some((source) => new RegExp(source, "u").test(text));
    expect(sign(" ⠋ Running… (⎋ to cancel)")).toBe(true);
    expect(sign(" ⠴ Running… (⎋ to cancel)  ")).toBe(true);
    for (const text of [" Running… (⎋ to cancel)", " ⠋ Running tests", " Running… done", "⠋ Running… (⎋ to cancel) and more", " the Running… (⎋ to cancel)"]) {
      expect(sign(text), text).toBe(false);
    }
  });
});

// omp 18.6.1 and 18.12.6 (omp-gang three, tester 5, 2026-10-26, W4): a draft typed at the desk with omp's queue
// prefix (`-> text` or `=> text`) shows omp's `Queueing ➤` label on the box's first row and the body under it. The
// tester's view said `empty` for several seconds. These captures read `draft` as they stand: the label row and the body
// are the box's draft display, the label painted in the grey the profile names for the empty box's ghost hint
// (`inlineHint`, rgb(107,114,128)) included. An idle pane's view is read every `pollIdleMs` (12 s), so a desk edit
// shows late; the screen itself reads draft.
describe("omp's queue-prefix draft (Queueing ➤) reads as a draft (18.6.1 and 18.12.6)", () => {
  const DRAFTS: readonly [string, string][] = [
    ["omp--v18-6-1-draft-queueing-painted--w120.txt", "Queueing ➤ hello queue draft"],
    ["omp--draft-queueing-body--v18.12.6.txt", "Queueing ➤ then do this"],
    ["omp--draft-queueing-label--v18.12.6.txt", "Queueing ➤"],
  ];

  for (const [name, text] of DRAFTS) {
    it(`${name}: composer draft, the label part of the box's text, no placeholder`, () => {
      const read = readScreen(fixtureRows(name, SURFACE_FIXTURES_DIR), "omp", idleFor("omp"));
      expect(read.surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "draft" });
      expect(read.frame?.interior.text).toBe(text);
      expect(read.frame?.placeholder).toBe(false);
    });
  }

  it("the painted capture keeps its label colour: the hint colour is the profile's, and the draft still reads", () => {
    const rows = fixtureRows("omp--v18-6-1-draft-queueing-painted--w120.txt", SURFACE_FIXTURES_DIR);
    expect(rows.some((row) => row.segments.some((segment) => segment.text.includes("Queueing ➤") && JSON.stringify(segment.style).includes("107,114,128")))).toBe(true);
    expect(idleFor("omp")!.inlineHint?.fg).toContain("rgb(107,114,128)");
  });

  it("the empty box with its ghost hint beside it is still empty", () => {
    expect(readScreen(fixtureRows("omp--box-empty--v18.12.6.txt", SURFACE_FIXTURES_DIR), "omp", idleFor("omp")).surface.composer).toBe("empty");
  });
});

// Issue 747: pi-zentui 0.34.0 on pi 1.5.0 draws its Opencode editor as rail rows between pi's two rules
// (a pad row, the editor rows, a pad row, then the model row), and the profile's wide column-zero prompt
// took the rails and the model row for a draft, so every send was refused draft_present. Live captures
// (fixtures/panes/README.md); the rail layout is the profile's last `frameAlternates` entry.
describe("pi-zentui's rail editor (issue 747)", () => {
  const pi = idleFor("pi")!;
  const STARSHIP = [
    "pi--v150-zentui-idle--w120.txt",
    "pi--v150-zentui-idle--w80.txt",
    "pi--v150-zentui-nerd-idle--w120.txt",
    "pi--v150-zentui-echo-idle--w120.txt",
  ];
  const IDLE = [...STARSHIP, "pi--v150-zentui-native-footer-idle--w120.txt"];
  const DRAFTS: readonly [string, string][] = [
    ["pi--v150-zentui-draft--w120.txt", "hello from the probe"],
    ["pi--v150-zentui-draft--w80.txt", "hello from the probe"],
    ["pi--v150-zentui-nerd-draft--w120.txt", "hello from the probe"],
    ["pi--v150-zentui-native-footer-draft--w120.txt", "hello from the probe"],
    ["pi--v150-zentui-multiline-draft--w120.txt", "hello from the probe second line of the draft"],
    ["pi--v150-zentui-multiline-draft--w80.txt", "hello from the probe second line of the draft"],
    ["pi--v150-zentui-wrapped-draft--w120.txt", "this draft is long enough to wrap inside the rail editor so the reader has to join two rows of typed text into one line of draft"],
    // A typed `|` behind the rail is the person's text, never a rail.
    ["pi--v150-zentui-pipe-draft--w80.txt", "|"],
  ];
  const plain = (name: string) => readScreen(rowsOf(stripSgr(readFileSync(join(PANES_DIR, name), "utf8"))), "pi", pi);

  it.each(IDLE)("%s: the empty rail box is free", (name) => {
    const found = own(name);
    expect(found.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    expect(found.frame!.interior.text).toBe("");
    expect(isFree(found.surface)).toBe(true);
  });

  it.each(DRAFTS)("%s: the typed text is the draft, the rails and the model row are not", (name, text) => {
    const found = own(name);
    expect(found.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
    expect(found.frame!.interior.text).toBe(text);
  });

  it("pi's /model selector over the rail setup stays a dialog", () => {
    for (const name of ["pi--v150-zentui-model-selector--w120.txt", "pi--v150-zentui-model-selector--w80.txt"]) {
      expect(own(name).surface).toMatchObject({ modal: "unreadable", composer: "unknown" });
    }
  });

  it("the framed echo of a sent prompt is no box: the screen cut above the live box never reads free", () => {
    const rows = fixtureRows("pi--v150-zentui-echo-idle--w120.txt");
    const live = own("pi--v150-zentui-echo-idle--w120.txt").frame!;
    expect(rows.slice(0, live.top).map(rowText).some((text) => text === "| say hi")).toBe(true);
    const cut = readScreen(rows.slice(0, live.top), "pi", pi);
    expect(cut.frame).toBeNull();
    expect(isFree(cut.surface)).toBe(false);
  });

  it("a plain read takes the box under pi's native footer, and never frees it under the Starship footer", () => {
    expect(plain("pi--v150-zentui-native-footer-idle--w120.txt").surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    expect(plain("pi--v150-zentui-native-footer-draft--w120.txt").frame!.interior.text).toBe("hello from the probe");
    for (const name of [...STARSHIP, ...DRAFTS.map(([n]) => n)].filter((n) => !n.includes("native-footer"))) {
      expect(plain(name).surface).toMatchObject({ composer: "unknown", reason: "no-match" });
    }
  });

  // The column-zero box must not lose a draft to the rail rule: stock pi with rail-led rows typed in it.
  describe("stock pi with rail-led rows in its draft", () => {
    const stock = (draft: readonly string[]) => {
      const rows = readFileSync(join(PANES_DIR, "pi--v110-stock-draft.txt"), "utf8").split("\n");
      const at = rows.findIndex((row) => row.startsWith("collie stock pi draft probe"));
      rows.splice(at, 1, ...draft);
      return readScreen(rowsOf(rows.join("\n")), "pi", pi);
    };

    it("a rail-led first row under a plain row keeps every row in the draft", () => {
      const read = stock(["| a | b |", "plain text"]);
      expect(read.surface).toMatchObject({ composer: "draft" });
      expect(read.frame!.interior.text).toBe("| a | b | plain text");
    });

    it("rows that are all rail-led never read free", () => {
      for (const draft of [["| a | b |"], ["| a | b |", "| c | d |"], ["│ x", "│ y", "│ z"]]) {
        const read = stock(draft);
        expect(isFree(read.surface)).toBe(false);
        expect(read.surface.composer).not.toBe("empty");
      }
    });
  });
});

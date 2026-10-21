import { describe, expect, it } from "vitest";

import { agentOf, fixtureRows, idleFor, readScreen } from "../../test/surface-corpus";
import { commandListAt, ownCommandList, runningSign } from "./cues";
import { findInputFrame, rowText } from "./frame";
import { isFree } from "./surface";
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

  // A list that points at another command (`/mod` typed, `model` pointed), the selector `/model` opens
  // and the settings screen `/settings` opens all stay dialogs.
  for (const name of [
    "pi--v130-slash-mod-partial--w120.txt",
    "omp--v18-6-slash-mod-partial--w120.txt",
    "pi--v130-model-selector-empty--w120.txt",
    "pi--v0871-model-selector-empty--w120.txt",
    "omp--v18-6-model-selector-empty--w120.txt",
    "pi--v130-settings-screen--w120.txt",
    "omp--v18-6-settings-screen--w120.txt",
    "pi--v110-slash-palette.txt",
    "pi--v120-slash-palette-padded.txt",
    "omp--slash-palette.txt",
  ]) {
    it(`${name}: still reads as a dialog`, () => {
      const read = own(name);
      expect(read.surface.modal).toBe("unreadable");
      expect(isFree(read.surface)).toBe(false);
      expect(labelOf(name).state).toBe("dialog");
    });
  }

  it("a list that points at another command finds no own list, on either profile", () => {
    for (const [name, harness] of [
      ["pi--v130-slash-mod-partial--w120.txt", "pi"],
      ["omp--v18-6-slash-mod-partial--w120.txt", "omp"],
    ] as const) {
      const rows = fixtureRows(name);
      const idle = idleFor(harness)!;
      const frame = findInputFrame(rows, idle);
      const texts = rows.map(rowText);
      expect(frame === null ? null : ownCommandList(texts, frame, idle), name).toBeNull();
      if (frame !== null) expect(commandListAt(texts, frame, idle.volatile.below.commandList)?.pointed, name).toBe("/model");
    }
  });
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

  // The controls stay dialogs: a choice between the rules is no soft wrap. An explicit-newline draft of
  // short rows reads the same as such a list, so it stays a dialog too, the conservative side.
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

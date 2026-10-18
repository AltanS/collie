import { describe, expect, it } from "vitest";

import { fixtureRows, idleFor } from "../../test/surface-corpus";
import { commandListAt, ownCommandList } from "./cues";
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

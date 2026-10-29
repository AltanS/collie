import { describe, expect, it } from "vitest";

import { fixtureRows, idleFor, readScreen } from "../../test/surface-corpus";
import { labelOf, own } from "../../test/surface-fold";
import { commandListAt, ownCommandList } from "./cues";
import { findInputFrame, rowText } from "./frame";
import { isFree } from "./surface";

// MUSE-03 (#519): Muse draws its slash palette INSIDE the box, between the prompt row and the
// bottom rule, and marks the highlighted entry bold with no pointer glyph (the adapter's
// chrome.ts reads the same mark). The profile names that list (`sides: ["inside"]`,
// `pointerBold`), so the typed command's own palette reads as composing like Claude's list
// under its box: Enter there runs the command already typed. A palette whose bold row is
// another command is no own list, and Enter stays withheld.
const IDLE = idleFor("muse")!;
const LIST = IDLE.volatile.below.commandList;

describe("the typed command's own slash palette inside Muse's box (MUSE-03, #519)", () => {
  it("muse--palette-skill.txt: /plan typed, its own bold entry under it is no dialog", () => {
    const read = own("muse--palette-skill.txt");
    expect(read.frame?.interior.text).toBe("/plan");
    expect(read.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
    expect(read.cues?.strength).toBe("none");
    expect(labelOf("muse--palette-skill.txt").state).toBe("popup");

    const rows = fixtureRows("muse--palette-skill.txt");
    const frame = findInputFrame(rows, IDLE)!;
    const texts = rows.map(rowText);
    expect(commandListAt(texts, frame, LIST, rows)).toMatchObject({ pointed: "/plan", side: "inside" });
    expect(ownCommandList(texts, frame, IDLE, rows)).not.toBeNull();
  });

  it("muse--slash-palette-1410.txt: bare / typed, the palette points at /bug, so no own list", () => {
    const read = own("muse--slash-palette-1410.txt");
    expect(isFree(read.surface)).toBe(false);
    expect(read.surface.modal).toBe("unreadable");
    expect(labelOf("muse--slash-palette-1410.txt").state).toBe("popup");

    const rows = fixtureRows("muse--slash-palette-1410.txt");
    const frame = findInputFrame(rows, IDLE)!;
    expect(frame.interior.text).toBe("/");
    const texts = rows.map(rowText);
    const list = commandListAt(texts, frame, LIST, rows);
    expect(list).toMatchObject({ pointed: "/bug", side: "inside" });
    expect(list?.entries).toEqual(["/bug", "/clear", "/compact", "/copy", "/deep-research", "/effort", "/export"]);
    expect(ownCommandList(texts, frame, IDLE, rows)).toBeNull();
  });

  // Derived from the real 1.4.10 capture above by typing the highlighted command in full: the
  // same palette, the prompt row holding /bug. No filtered 1.4.10 capture exists (#519 research),
  // so this screen is built in the test and labelled as such, never saved as a fixture.
  it("the 1410 palette with /bug typed in full reads as its own list (derived screen)", () => {
    const base = fixtureRows("muse--slash-palette-1410.txt");
    const frame = findInputFrame(base, IDLE)!;
    const rows = base.map((row, i) => (i === frame.interior.prompt ? { segments: [{ ...row.segments[0]!, text: "❯ /bug" }] } : row));
    const derived = findInputFrame(rows, IDLE)!;
    const texts = rows.map(rowText);
    expect(derived.interior.text).toBe("/bug");
    expect(commandListAt(texts, derived, LIST, rows)).toMatchObject({ pointed: "/bug", side: "inside" });
    expect(ownCommandList(texts, derived, IDLE, rows)).not.toBeNull();
    const read = readScreen(rows, "muse", IDLE);
    expect(read.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
    expect(read.cues?.strength).toBe("none");
  });

  it("muse--palette-hint-moved.txt: the bold row moved to another command, so no own list", () => {
    const rows = fixtureRows("muse--palette-hint-moved.txt");
    const frame = findInputFrame(rows, IDLE)!;
    const texts = rows.map(rowText);
    expect(frame.interior.text).toBe("/resume");
    expect(commandListAt(texts, frame, LIST, rows)).toMatchObject({ pointed: "/resume-claude", side: "inside" });
    expect(ownCommandList(texts, frame, IDLE, rows)).toBeNull();
    expect(isFree(own("muse--palette-hint-moved.txt").surface)).toBe(false);
  });

  // A complete command carries Muse's bracketed argument hint in the bottom rule's colour
  // (`/resume [--last|<id-or-name>]`): the hint is no draft text, so the read is the typed
  // command and its own bold entry reads as its own list. With the hint counted as draft the
  // pointed command could never be the typed one and the palette stayed a modal.
  it("muse--palette-hint-skills.txt: /resume typed with its hint, its bold entry first is its own list", () => {
    const rows = fixtureRows("muse--palette-hint-skills.txt");
    const frame = findInputFrame(rows, IDLE)!;
    const texts = rows.map(rowText);
    expect(frame.interior.text).toBe("/resume");
    expect(commandListAt(texts, frame, LIST, rows)).toMatchObject({ pointed: "/resume", side: "inside" });
    expect(ownCommandList(texts, frame, IDLE, rows)).not.toBeNull();
    const read = own("muse--palette-hint-skills.txt");
    expect(read.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
    expect(read.cues?.strength).toBe("none");
  });

  it("muse--palette-hint.txt: /model typed with its hint, its one bold entry is its own list", () => {
    const rows = fixtureRows("muse--palette-hint.txt");
    const frame = findInputFrame(rows, IDLE)!;
    const texts = rows.map(rowText);
    expect(frame.interior.text).toBe("/model");
    expect(commandListAt(texts, frame, LIST, rows)).toMatchObject({ pointed: "/model", side: "inside" });
    expect(ownCommandList(texts, frame, IDLE, rows)).not.toBeNull();
    expect(own("muse--palette-hint.txt").surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
  });

  // Derived from muse--palette-hint.txt by repainting the hint run in the typed text's own
  // colour: a bracketed run the person typed stays draft text, so the read keeps it and the
  // palette is no own list. Built in the test, never saved as a fixture.
  it("a bracketed run in the typed colour stays in the draft (derived screen)", () => {
    const base = fixtureRows("muse--palette-hint.txt");
    const frame = findInputFrame(base, IDLE)!;
    const promptRow = base[frame.interior.prompt]!;
    const typedFg = promptRow.segments.find((segment) => segment.text.includes("/model"))?.fg;
    const rows = base.map((row, i) =>
      i === frame.interior.prompt
        ? { segments: row.segments.map((segment) => (segment.text.includes("[<model-id>]") ? { ...segment, fg: typedFg } : segment)) }
        : row,
    );
    const derived = findInputFrame(rows, IDLE)!;
    const texts = rows.map(rowText);
    expect(derived.interior.text).toBe("/model [<model-id>]");
    expect(ownCommandList(texts, derived, IDLE, rows)).toBeNull();
  });

  it("muse--palette-typed-arg.txt: a typed argument stays in the draft and no list stands", () => {
    const rows = fixtureRows("muse--palette-typed-arg.txt");
    const frame = findInputFrame(rows, IDLE)!;
    expect(frame.interior.text).toBe("/model x");
    expect(own("muse--palette-typed-arg.txt").surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
  });

  it("no Muse dialog fixture reads modal none under its profile", () => {
    for (const name of ["muse--ask-color.txt", "muse--approval-ls.txt", "muse--palette-exact.txt", "muse--palette-partial.txt"]) {
      const read = own(name);
      expect(read.surface.modal, name).not.toBe("none");
      expect(isFree(read.surface), name).toBe(false);
      expect(labelOf(name).state, name).toBe("dialog");
    }
  });

  it("a multiline prose draft is the box's own text, not a pointed list (live capture 2026-10-21)", () => {
    // muse--draft-multiline-live.txt is a real `pane read --format ansi`
    // capture of Muse 1.4.11 with a three-line draft typed but not sent:
    // prompt row plus soft-wrapped continuation rows over the bottom rule.
    const rows = fixtureRows("muse--draft-multiline-live.txt");
    const found = findInputFrame(rows, IDLE);
    expect(found).not.toBeNull();
    expect(found?.interior.text).toContain("first line of a long draft");
    expect(found?.interior.text).toContain("third line continues here as well");
    const read = readScreen(rows, "muse", IDLE);
    expect(read.surface).toMatchObject({ modal: "none", composer: "draft" });
    expect(read.cues?.cues.map((cue) => cue.kind)).not.toContain("pointer-row");
    expect(read.cues?.strength).toBe("none");
  });

  // The rule that reads it so (`frame.draftLines`, cues.ts `draftWrap`): Muse's dialogs point with `›` and
  // `⟩`, never with the prompt's `❯`, so rows under `❯` that hold no option, no key hint and no named
  // command list are the draft's own lines. Each piece of that is pinned here against the same capture.
  const row = (text: string) => ({ segments: [{ text, style: {}, muted: false }] });
  const LIVE = "muse--draft-multiline-live.txt";

  it("the same capture without the layout's draftLines still reads as a pointed list, never as free", () => {
    const idle = { ...IDLE, frame: { ...IDLE.frame, draftLines: undefined } };
    const read = readScreen(fixtureRows(LIVE), "muse", idle);
    expect(read.cues?.strength).toBe("strong");
    expect(read.surface.modal).toBe("unreadable");
    expect(isFree(read.surface)).toBe(false);
  });

  const LISTS: readonly [string, number, string][] = [
    ["a numbered row", 4, "  2. second line continues here"],
    ["a checkbox row", 4, "  [ ] second line continues here"],
    ["a key hint row", 6, "  Enter to select"],
  ];
  for (const [what, at, text] of LISTS) {
    it(`a newline draft with ${what} under the glyph stays a list, never a draft`, () => {
      const rows = fixtureRows(LIVE).map((line, i) => (i === at ? row(text) : line));
      const read = readScreen(rows, "muse", IDLE);
      expect(read.surface.composer).not.toBe("draft");
      expect(read.surface.modal).not.toBe("none");
      expect(isFree(read.surface)).toBe(false);
    });
  }

  // The blanket strip of the prompt glyph read this real palette, pointed at another command, as a draft
  // (Enter would run /resume-claude). The profile's command list in the box keeps it a list.
  it("muse--palette-hint-moved.txt stays unreadable: a named command list in the box is no draft's lines", () => {
    const read = own("muse--palette-hint-moved.txt");
    expect(read.surface).toMatchObject({ modal: "unreadable", composer: "unknown" });
    expect(read.cues?.strength).toBe("strong");
  });
});

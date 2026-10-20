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
});

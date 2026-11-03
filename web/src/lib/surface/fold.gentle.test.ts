import { describe, expect, it } from "vitest";

import { composerDraft, locateComposer } from "../harness/pi/composer";
import { fixtureRows, idleFor, readScreen, rowsOf } from "../../test/surface-corpus";
import { rowText } from "./frame";
import { isFree, modalWord } from "./surface";

const idle = idleFor("pi")!;
const capture = (state: string) => fixtureRows(`pi--v140-gentle-float-${state}--w100.txt`);

describe("Gentle Shell 4.5.1 float editor on herdr-core (Pi 1.4.0)", () => {
  it("recognizes the empty input and hides its placeholder from the draft", () => {
    const rows = capture("idle");
    expect(readScreen(rows, "pi", idle).surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    expect(locateComposer(rows)?.layout).toBe("gentle");
    expect(composerDraft(rows)).toBeNull();
  });

  it.each([["draft", "hola mundo"], ["multiline", "hola mundo segunda linea"]])("preserves the captured %s instead of treating it as empty", (state, draft) => {
    const rows = capture(state);
    const read = readScreen(rows, "pi", idle);
    expect(read.surface.composer).toBe("draft");
    expect(read.frame?.interior.text).toBe(draft);
    expect(composerDraft(rows)).toBe(draft);
    expect(isFree(read.surface)).toBe(false);
  });

  it("refuses the real selector that replaced the editor", () => {
    const rows = capture("dialog");
    expect(locateComposer(rows)).toBeNull();
    expect(isFree(readScreen(rows, "pi", idle).surface)).toBe(false);
  });

  const original = capture("idle").map(rowText).join("\n");
  // Mutations of a live capture exercise states that must fail closed; they are not new fixtures.
  it.each(["working…", "queued", "checking…"])("does not read %s as idle", (phase) => {
    const rows = rowsOf(original.replace("waiting for input", phase));
    expect(isFree(readScreen(rows, "pi", idle).surface)).toBe(false);
  });

  it.each(["NORMAL", "SELECT", "INSERT · ↑ 2 more"])("refuses the editor in %s mode", (mode) => {
    const rows = rowsOf(original.replace("INSERT", mode));
    expect(locateComposer(rows)).toBeNull();
    expect(isFree(readScreen(rows, "pi", idle).surface)).toBe(false);
  });

  // A left rail in the transcript, such as a quoted block, is no float editor (derived captures, fixtures README).
  it("reads stock pi's own box under a quoted rail, and the rail stays transcript", () => {
    const rows = fixtureRows("pi--v110-stock-idle-quote-rail.txt");
    const read = readScreen(rows, "pi", idle);
    expect(read.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    expect(locateComposer(rows)?.layout).toBe("stock");
    expect(rowText(rows[read.frame!.top]!).startsWith(" ▎")).toBe(false);
  });

  it("reads a stock pi dialog under a quoted rail as the dialog, never as a float editor", () => {
    const rows = fixtureRows("pi--v130-core-question-quote-rail--w120.txt");
    const read = readScreen(rows, "pi", idle);
    expect(locateComposer(rows)).toBeNull();
    expect(modalWord(read.surface.modal)).toBe("ask");
    expect(isFree(read.surface)).toBe(false);
  });

  // A quote that ends on a bare rail row has the float editor's bottom edge; only the editor's own
  // first row (a flower and its phase) may open the frame.
  it.each(["pi--v110-stock-idle-quote-rail.txt", "pi--v130-core-question-quote-rail--w120.txt"])("does not claim a quoted rail that ends on a bare rail row in %s", (name) => {
    const texts = fixtureRows(name).map(rowText);
    const last = texts.findLastIndex((row) => row.startsWith(" ▎ "));
    texts[last] = " ▎";
    const rows = rowsOf(texts.join("\n"));
    expect(locateComposer(rows)?.layout).not.toBe("gentle");
    expect(rowText(rows[readScreen(rows, "pi", idle).frame?.top ?? 0]!).startsWith(" ▎")).toBe(false);
  });

  it("does not claim the float editor's own rows quoted above a stock pi dialog", () => {
    const texts = fixtureRows("pi--v130-core-question-quote-rail--w120.txt").map(rowText);
    const at = texts.findIndex((row) => row.startsWith(" ▎ "));
    texts.splice(at, 3, " ▎ ✿ waiting for input · INSERT", " ▎   type, or / for commands", " ▎");
    const rows = rowsOf(texts.join("\n"));
    expect(locateComposer(rows)).toBeNull();
    expect(isFree(readScreen(rows, "pi", idle).surface)).toBe(false);
  });

  it("does not accept an old editor printed above later output", () => {
    const rows = rowsOf(`${original}\nOutput after the editor`);
    expect(isFree(readScreen(rows, "pi", idle).surface)).toBe(false);
  });
});

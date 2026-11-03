import { describe, expect, it } from "vitest";

import { composerDraft, locateComposer } from "../harness/pi/composer";
import { fixtureRows, idleFor, readScreen, rowsOf } from "../../test/surface-corpus";
import { rowText } from "./frame";
import { isFree } from "./surface";

const idle = idleFor("pi")!;
const capture = (state: string) => fixtureRows(`pi--gentle-v451-float-${state}--w100.txt`);

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

  it("does not accept an old editor printed above later output", () => {
    const rows = rowsOf(`${original}\nOutput after the editor`);
    expect(isFree(readScreen(rows, "pi", idle).surface)).toBe(false);
  });
});

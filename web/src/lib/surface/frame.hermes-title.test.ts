import { describe, expect, it } from "vitest";

import { requireProfile } from "./profile";
import { findInputFrame } from "./frame";
import { rowsOf, readScreen } from "../../test/surface-corpus";
import { isFree } from "./surface";

// Issue 657: Hermes 0.22.5 draws the session title inside the top rule of the composer. The hermes
// profile reads that title on the top anchor only (idle top and the interior alternate's top), with
// one to three dashes after it. These are the negative cases around that anchor: what must still be
// a clean no-match, and which row the frame takes as the top when a transcript row looks like a rule.
const IDLE = requireProfile("hermes").idle;
const BARE = "─".repeat(120);
const PROMPT = "❯ Type / to browse commands, or Ctrl+P for the palette";
const TITLED = "── Session Title ─";

const frameOf = (rows: string[]) => findInputFrame(rowsOf(rows.join("\n")), IDLE);
const surfaceOf = (rows: string[]) => readScreen(rowsOf(rows.join("\n")), "hermes", IDLE).surface;

describe("hermes titled top rule (issue 657): negative cases", () => {
  it("reads a title that holds box-drawing characters whole, as the label", () => {
    const frame = frameOf(["── a ─ b ─", PROMPT, BARE]);
    expect(frame).toMatchObject({ top: 0, bottom: 2, label: "a ─ b" });
    expect(isFree(surfaceOf(["── a ─ b ─", PROMPT, BARE]))).toBe(true);
  });

  it("reads a CJK title, counting its double-width cells toward the eight-cell floor", () => {
    const frame = frameOf(["── 工作階段 ─", PROMPT, BARE]);
    expect(frame).toMatchObject({ top: 0, bottom: 2, label: "工作階段" });
    expect(isFree(surfaceOf(["── 工作階段 ─", PROMPT, BARE]))).toBe(true);
  });

  it("refuses a title that runs the full pane width, with no row taken as the top", () => {
    const full = `── Session Title ${"─".repeat(120 - 17)}`;
    expect(frameOf([full, PROMPT, BARE])).toBeNull();
    expect(surfaceOf([full, PROMPT, BARE])).toMatchObject({ turn: "unknown", modal: "unknown", composer: "unknown", reason: "no-match" });
  });

  it("does not walk from a transcript row that looks like a titled rule down to a full-width title", () => {
    // The real top matches nothing here, so the walk must not reach past it to the transcript row and
    // read the rows between as a draft (it did, before the interior rows excluded a titled rule).
    const full = `── Session Title ${"─".repeat(120 - 17)}`;
    const rows = [TITLED, "reply", "reply", full, PROMPT, BARE];
    expect(frameOf(rows)).toBeNull();
    expect(surfaceOf(rows)).toMatchObject({ composer: "unknown", reason: "no-match" });
  });

  it("takes the real box as the frame when a titled-looking transcript row sits three rows above it", () => {
    for (const [name, rows, top] of [
      ["bare box", [TITLED, "x", "y", BARE, PROMPT, BARE], 3],
      ["titled box", [TITLED, "x", "y", "── Real Title ─", PROMPT, BARE], 3],
      ["one more row between", [TITLED, "x", "y", "z", BARE, PROMPT, BARE], 4],
    ] as const) {
      const frame = frameOf([...rows]);
      expect(frame?.top, name).toBe(top);
      expect(frame?.label ?? null, name).toBe(name === "titled box" ? "Real Title" : null);
      expect(isFree(surfaceOf([...rows])), name).toBe(true);
    }
  });

  it("refuses a bottom rule that carries a title, bare or under a titled top", () => {
    expect(frameOf([BARE, PROMPT, TITLED])).toBeNull();
    expect(frameOf([TITLED, PROMPT, TITLED])).toBeNull();
    expect(surfaceOf([BARE, PROMPT, TITLED])).toMatchObject({ composer: "unknown", reason: "no-match" });
  });
});

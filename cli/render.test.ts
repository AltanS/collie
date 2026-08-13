import { describe, expect, test } from "bun:test";

import { renderInputs, takePlainFlag, wantsRich } from "./render.ts";

// The whole point of this seam is that the plain path is what runs unless three things are all true
// at once. Every suite in `cli/` and both shell suites depend on that: they capture output from a
// non-TTY, and if the rich branch could ever be chosen there, every golden in the repo would be
// wrong. So the rule is pinned exhaustively rather than by example.

describe("wantsRich", () => {
  test("only a terminal that is not CI and was not overridden gets the drawn view", () => {
    const table: [boolean, boolean, boolean, boolean][] = [
      // isTTY, ci,    plain, rich
      [true, false, false, true],
      [true, false, true, false],
      [true, true, false, false],
      [true, true, true, false],
      [false, false, false, false],
      [false, false, true, false],
      [false, true, false, false],
      [false, true, true, false],
    ];
    for (const [isTTY, ci, plain, rich] of table) {
      expect(wantsRich({ isTTY, ci, plain })).toBe(rich);
    }
  });
});

describe("renderInputs", () => {
  test("a pipe is never a terminal, whatever the environment says", () => {
    expect(renderInputs({}, false, false).isTTY).toBe(false);
    expect(renderInputs({ CI: "true" }, true, false).isTTY).toBe(true);
  });

  test("CI counts however the runner spells it", () => {
    for (const value of ["1", "true", "TRUE", "yes", "woodpecker"]) {
      expect(renderInputs({ CI: value }, true, false).ci).toBe(true);
    }
  });

  test("CI unset, empty, `false` or `0` is not CI — an exported-but-empty CI is a laptop", () => {
    for (const value of [undefined, "", "   ", "false", "FALSE", "0"]) {
      expect(renderInputs({ CI: value }, true, false).ci).toBe(false);
    }
  });
});

describe("takePlainFlag", () => {
  test("takes the flag out wherever it sits, and leaves everything else in order", () => {
    expect(takePlainFlag(["--plain", "pack", "status"])).toEqual({ plain: true, rest: ["pack", "status"] });
    expect(takePlainFlag(["pack", "status", "--plain"])).toEqual({ plain: true, rest: ["pack", "status"] });
    expect(takePlainFlag(["pack", "--plain", "status"])).toEqual({ plain: true, rest: ["pack", "status"] });
  });

  test("no flag leaves argv untouched", () => {
    expect(takePlainFlag(["logs", "200"])).toEqual({ plain: false, rest: ["logs", "200"] });
    expect(takePlainFlag([])).toEqual({ plain: false, rest: [] });
  });

  test("only the exact spelling is taken — a value that merely starts with it survives", () => {
    expect(takePlainFlag(["join", "--label", "--plainly"])).toEqual({
      plain: false,
      rest: ["join", "--label", "--plainly"],
    });
    expect(takePlainFlag(["--plain=1"])).toEqual({ plain: false, rest: ["--plain=1"] });
  });
});

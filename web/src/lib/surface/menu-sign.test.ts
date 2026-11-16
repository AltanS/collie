import { describe, expect, it } from "vitest";

import { menuSign, menuWindow, type MenuBox } from "./menu-sign";

// M102 spec 12, decision 4: each sign on its own, and the rows it never reads. The corpus run is
// menu-sign.corpus.test.ts.

const RULE = "─".repeat(40);
const box = (top: number, first: number, last: number): MenuBox => ({ top, skip: new Set(Array.from({ length: last - first + 1 }, (_, i) => first + i)) });

describe("the generic menu sign", () => {
  it.each([
    ["a pointer on a numbered option", [" Do you want to proceed?", " ❯ 1. Yes", "   2. No"], "pointer"],
    ["a pointer on a choice word", ["Allow this command?", "› Allow", "  Deny"], "pointer"],
    ["a numbered list with no pointer", ["Pick one", "  1. Red", "  2. Blue"], "numbered"],
    ["a list with the number and two spaces", ["Do you trust this folder?", "⟩ 1  Trust and continue", "  2  Quit"], "pointer"],
    ["choice rows with no pointer or number", ["Run it?", "  Yes", "  No"], "choices"],
    ["choice words side by side", ["Update now?", "                Skip  Continue"], "choices"],
    ["a (y/n) form", ["Overwrite the file? (y/n)"], "yes-no"],
    ["a [Y/n] form", ["Continue [Y/n]"], "yes-no"],
    ["a menu hint", ["Something", "Enter to confirm · Esc to cancel"], "hint"],
    ["an arrow hint", ["Something", "↑/↓ to navigate"], "hint"],
    ["two key hints of any verb", ["Sessions", " enter resume   esc exit   tab focus"], "hint"],
    ["a row of single keys", ["a approve  |  s request changes  |  c comment"], "single-key"],
    ["a picker's place in its list", ["  first", "  second", "  (1/9)"], "position"],
    ["a title that names only its close key", ["      Commands                     esc", "      Switch model"], "dismiss"],
    ["a field that filters as the person types", ["  some model", "type to search"], "search"],
    ["a pointed list of three", ["  Extra High    Most", "❯ High          More", "  Medium        Less"], "pointed-list"],
    ["a pointed list of two between rules", [RULE, "❯ 256k (active)", "  500k", RULE], "pointed-list"],
    ["a slash query with a choice under it", ["❯ /usa", "  /usage  Show session usage"], "commands"],
  ])("fires on %s", (_what, rows, kind) => {
    expect(menuSign(rows)?.kind).toBe(kind);
  });

  it.each([
    ["a plain answer", ["The test fails because the fixture is stale.", "I updated it."]],
    ["a single numbered line", ["1. The repo name or the issue URL."]],
    ["a long prompt echoed behind the prompt glyph, wrapped", ["❯ please read the file and tell me whether the tests cover the new branch of", "  the parser, and if they do not, write one that does and run the suite once", "  more before you answer me"]],
    ["a tool result under a prompt echo", ["❯ /plugin", "  ⎿  Marketplace updated"]],
    ["a composer footer", ["  ⏎ send   ⇧⏎ newline   ⌃T transcript"]],
    ["a fold hint", ["  Read 1 file (ctrl+o to expand)"]],
  ])("does not fire on %s", (_what, rows) => {
    expect(menuSign(rows)).toBeNull();
  });

  it("reads no row of a found box: a draft that quotes a dialog is the person's text", () => {
    const rows = ["The agent's answer.", RULE, "❯ when it asks, pick 1. Yes", "  2. No, and tell Claude what to do (y/n)", RULE, "  ? for shortcuts"];
    expect(menuSign(rows)).not.toBeNull();
    expect(menuSign(rows, box(1, 2, 3))).toBeNull();
  });

  it("over a found box reads the transcript for one row only: a list further up is the agent's answer", () => {
    const rows = ["Options I see:", "  1. Rename it", "  2. Delete it", "", RULE, "❯ ", RULE];
    expect(menuSign(rows)).not.toBeNull();
    expect(menuSign(rows, box(4, 5, 5))).toBeNull();
    const over = ["The answer.", "Overwrite it? (y/n)", RULE, "❯ ", RULE];
    expect(menuSign(over, box(2, 3, 3))?.kind).toBe("yes-no");
  });

  it("skips the rows the profile names around the box", () => {
    const rows = ["The answer.", "  1: Bad    2: Fine   3: Good   0: Dismiss", RULE, "❯ ", RULE];
    expect(menuSign(rows, box(2, 3, 3))?.kind).toBe("single-key");
    expect(menuSign(rows, { top: 2, skip: new Set([1, 3]) })).toBeNull();
  });

  it("with no box reads the last 24 non-blank rows, over any number of blank rows between them", () => {
    const rows = ["Pick one", "  1. Red", "  2. Blue", ...Array.from({ length: 20 }, () => ""), "status"];
    expect(menuSign(rows)?.kind).toBe("numbered");
    const far = ["  1. Red", "  2. Blue", ...Array.from({ length: 24 }, (_, i) => `row ${String(i)}`)];
    expect(menuSign(far)).toBeNull();
    expect([...menuWindow(far, null).keys()][0]).toBe(2);
  });
});

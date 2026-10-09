import { EXAMPLE_ROW, pickedOptions, recipeLine, recipeSkipsPrompts, recipesWithOptions, rowKey, togglePick } from "./launcher-add";
import type { Recipe } from "./types";

// The rules behind "Add your own" (M48 spec 02): which harnesses are offered, how chips exclude each
// other, the line a recipe builds (the bridge's `buildRecipe`, in table order), and the badge.

const CLAUDE: Recipe = {
  harness: "claude",
  label: "Claude Code",
  binary: "claude",
  options: [
    { id: "skip", label: "Skip permission prompts", args: "--dangerously-skip-permissions", group: "permissions", noPrompts: true },
    { id: "plan", label: "Plan mode", args: "--permission-mode plan", group: "permissions" },
    { id: "opus", label: "Model: opus", args: "--model opus", group: "model" },
    { id: "sonnet", label: "Model: sonnet", args: "--model sonnet", group: "model" },
    { id: "continue", label: "Continue last", args: "--continue" },
  ],
};
const GROK: Recipe = { harness: "grok", label: "Grok", binary: "grok", options: [] };

describe("recipesWithOptions", () => {
  it("lists only the harnesses that have an option to pick", () => {
    expect(recipesWithOptions({ recipes: [CLAUDE, GROK] }).map((r) => r.harness)).toEqual(["claude"]);
  });
});

describe("togglePick", () => {
  it("picks a chip, and a second tap on it clears it", () => {
    expect(togglePick(CLAUDE, [], "opus")).toEqual(["opus"]);
    expect(togglePick(CLAUDE, ["opus"], "opus")).toEqual([]);
  });

  it("one choice per group: another chip of the group replaces the first", () => {
    expect(togglePick(CLAUDE, ["opus"], "sonnet")).toEqual(["sonnet"]);
    expect(togglePick(CLAUDE, ["skip", "opus"], "plan")).toEqual(["opus", "plan"]);
  });

  it("a chip with no group simply toggles beside the others", () => {
    expect(togglePick(CLAUDE, ["opus"], "continue")).toEqual(["opus", "continue"]);
    expect(togglePick(CLAUDE, ["opus", "continue"], "continue")).toEqual(["opus"]);
  });

  it("ignores an id the recipe does not have", () => {
    expect(togglePick(CLAUDE, ["opus"], "nope")).toEqual(["opus"]);
  });
});

describe("recipeLine", () => {
  it("is the binary alone with nothing picked", () => {
    expect(recipeLine(CLAUDE, [])).toBe("claude");
  });

  it("puts the options in TABLE order, whatever order they were picked in", () => {
    expect(recipeLine(CLAUDE, ["continue", "opus", "skip"])).toBe("claude --dangerously-skip-permissions --model opus --continue");
    expect(pickedOptions(CLAUDE, ["continue", "skip"]).map((o) => o.id)).toEqual(["skip", "continue"]);
  });
});

describe("recipeSkipsPrompts", () => {
  it("is true when any picked option makes the agent act without asking", () => {
    expect(recipeSkipsPrompts(CLAUDE, ["opus"])).toBe(false);
    expect(recipeSkipsPrompts(CLAUDE, ["opus", "skip"])).toBe(true);
    expect(recipeSkipsPrompts(CLAUDE, [])).toBe(false);
  });
});

describe("the explainer's example", () => {
  it("is one launchers.toml row in the file's own grammar", () => {
    expect(EXAMPLE_ROW.split("\n")).toEqual(["[[launchers]]", 'command = "claude --model opus"', 'label = "Claude, opus"', 'harness = "claude"']);
  });
  it("an added row is picked on the New page under row:<line>", () => {
    expect(rowKey({ command: "claude --model opus" })).toBe("row:claude --model opus");
  });
});

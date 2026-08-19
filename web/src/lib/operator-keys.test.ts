import { CONTROL_PRESETS, ctrlPresetsFor } from "./operator-keys";
import { CATALOG_AGENTS } from "./agent-commands";
import { AGENT_FAMILIES } from "./operator-scope";
import type { OperatorKeyRow } from "./types";

// The `keys.toml` half of ADR 0018: a pane your rows address shows YOUR presets and nothing else; a
// pane none of them address keeps the shipped six.

const row = (r: Partial<OperatorKeyRow> & { label: string }): OperatorKeyRow => ({
  keys: ["ctrl+c"],
  danger: false,
  ...r,
});

const labels = (agent: string | undefined | null, mine: OperatorKeyRow[]) =>
  ctrlPresetsFor(agent, mine).map((p) => p.label);

describe("ctrlPresetsFor", () => {
  it("declaring nothing leaves every pane with the shipped presets", () => {
    expect(ctrlPresetsFor("claude")).toBe(CONTROL_PRESETS);
    expect(ctrlPresetsFor("claude", [])).toBe(CONTROL_PRESETS);
    expect(ctrlPresetsFor(null, [])).toBe(CONTROL_PRESETS);
  });

  it("replaces the shipped presets on a pane it addresses — never merges", () => {
    const mine = [row({ label: "Interrupt", keys: ["ctrl+c"] })];
    expect(labels("claude", mine)).toEqual(["Interrupt"]);
    expect(ctrlPresetsFor("claude", mine)).toEqual([
      { label: "Interrupt", keys: ["ctrl+c"], danger: false },
    ]);
  });

  it("leaves a pane none of the rows address exactly as shipped", () => {
    const mine = [row({ agent: "omp", label: "Interrupt" })];
    expect(ctrlPresetsFor("claude", mine)).toBe(CONTROL_PRESETS);
    expect(labels("omp", mine)).toEqual(["Interrupt"]);
  });

  it("an unscoped row reaches every pane, including one with no agent", () => {
    const mine = [row({ label: "Interrupt" })];
    expect(labels("codex", mine)).toEqual(["Interrupt"]);
    expect(labels(undefined, mine)).toEqual(["Interrupt"]);
  });

  it("a family scope reaches the family; a scoped row cannot be widened by the lookup", () => {
    const mine = [row({ agent: "claude", label: "Back", keys: ["shift+Tab"] })];
    expect(labels("claude-code", mine)).toEqual(["Back"]);
    // `claude-local` is not the catalog's name for the family, so it stays exact.
    expect(ctrlPresetsFor("claude-code", [row({ agent: "claude-local", label: "Back" })])).toBe(
      CONTROL_PRESETS,
    );
  });

  it("the narrower scope wins, in place, and one label is one button", () => {
    const mine = [
      row({ label: "Deploy", keys: ["ctrl+a"] }),
      row({ label: "Other", keys: ["ctrl+o"] }),
      row({ agent: "claude-code", label: "Deploy", keys: ["ctrl+b"] }),
    ];
    expect(ctrlPresetsFor("claude-code", mine).map((p) => [p.label, p.keys[0]])).toEqual([
      ["Deploy", "ctrl+b"],
      ["Other", "ctrl+o"],
    ]);
  });

  it("carries a whole sequence and the operator's own danger flag through", () => {
    const mine = [row({ label: "Yes", keys: ["Down", "Enter"], danger: true })];
    expect(ctrlPresetsFor("claude", mine)).toEqual([
      { label: "Yes", keys: ["Down", "Enter"], danger: true },
    ]);
  });
});

it("the scope ladder's family names are exactly the shipped catalog's", () => {
  // canonicalAgent() lives in operator-scope.ts but folds onto the CATALOG's own names — this pins
  // the two lists together, since adding an agent catalog is the one thing that moves both.
  expect([...AGENT_FAMILIES].toSorted()).toEqual([...CATALOG_AGENTS].toSorted());
});

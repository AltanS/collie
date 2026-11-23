import { describe, expect, it } from "vitest";

import { PALETTE_COMMANDS } from "../actions-palette/commands";
import { en } from "../i18n/messages/en";
import { ACTIONS } from "./actions";
import { HERDR_NAMES } from "./herdr-names";
import { buildKeymap } from "./keymap";

// THE ACTION "ANSWER THE NEXT ASK" (Asks build 6, 2026-11-23): it opens the Next up ask of the Asks page, from any
// screen. Its default is `prefix+a`, which no other action holds, and the owner can move it in `shortcuts.toml`.

const ROW = ACTIONS.find((action) => action.id === "answer_next_ask");

describe("the action answer_next_ask", () => {
  it("is in the table, in General, bound to prefix+a, with a label", () => {
    expect(ROW).toMatchObject({ id: "answer_next_ask", group: "global", defaults: ["prefix+a"], labelKey: "shortcuts.action.answer_next_ask" });
    expect(en["shortcuts.action.answer_next_ask"]).toBe("Answer the next ask");
  });

  it("is a row of Actions, named like the label", () => {
    const command = PALETTE_COMMANDS.find((entry) => entry.id === "answer_next_ask");
    expect(command?.labelKey).toBe("actions.command.answerNext");
    expect(en["actions.command.answerNext"]).toBe("Answer the next ask");
  });

  it("clashes with no other default, on every platform, and no Herdr name takes its place", () => {
    for (const mac of [false, true]) {
      const keymap = buildKeymap({ defaults: ACTIONS, mac });
      expect(keymap.diagnostics, `mac ${mac}`).toEqual([]);
      expect(keymap.prefixed.get("a")).toEqual({ action: "answer_next_ask" });
    }
    const others = ACTIONS.filter((action) => action.id !== "answer_next_ask").flatMap((action) => action.defaults);
    expect(others).not.toContain("prefix+a");
    expect(HERDR_NAMES.has("answer_next_ask")).toBe(false);
  });

  it("moves to the key shortcuts.toml names, and unbinds with an empty list", () => {
    const moved = buildKeymap({ defaults: ACTIONS, user: { answer_next_ask: ["prefix+y"] } });
    expect(moved.diagnostics).toEqual([]);
    expect(moved.prefixed.get("y")).toEqual({ action: "answer_next_ask" });
    expect(moved.prefixed.has("a")).toBe(false);
    const unbound = buildKeymap({ defaults: ACTIONS, user: { answer_next_ask: [] } });
    expect(unbound.prefixed.has("a")).toBe(false);
    expect(unbound.bindings.get("answer_next_ask")).toEqual([]);
  });
});

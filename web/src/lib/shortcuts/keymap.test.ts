import { describe, expect, it } from "vitest";

import { ACTIONS, type ActionDef } from "./actions";
import { buildKeymap } from "./keymap";
import type { Chord, Diagnostic, DiagnosticCode, UserShortcuts } from "./types";

function build(user?: UserShortcuts, mac = false) {
  return buildKeymap({ defaults: ACTIONS, user, mac });
}

function codes(diagnostics: readonly Diagnostic[]): DiagnosticCode[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

function chord(key: string, mods: Partial<Omit<Chord, "key">> = {}): Chord {
  return { key, ctrl: false, shift: false, alt: false, meta: false, ...mods };
}

describe("the defaults", () => {
  const keymap = build();

  it("load with no diagnostic", () => {
    expect(keymap.diagnostics).toEqual([]);
  });

  it("use ctrl+b as the prefix", () => {
    expect(keymap.prefix).toEqual([chord("b", { ctrl: true })]);
  });

  it("bind the table's actions behind the prefix", () => {
    expect(keymap.prefixed.get("c")).toEqual({ action: "new_tab" });
    expect(keymap.prefixed.get("?")).toEqual({ action: "help" });
    expect(keymap.prefixed.get("shift+n")).toEqual({ action: "new_space" });
    expect(keymap.prefixed.get("n")).toEqual({ action: "next_tab" });
    expect(keymap.prefixed.get("b")).toEqual({ action: "toggle_sidebar" });
    expect(keymap.direct.size).toBe(0);
  });

  it("number the tabs", () => {
    expect(keymap.prefixed.get("1")).toEqual({ action: "switch_tab", index: 1 });
    expect(keymap.prefixed.get("9")).toEqual({ action: "switch_tab", index: 9 });
  });

  it("open the sticky modes from a prefix binding", () => {
    expect(keymap.prefixed.get("r")).toEqual({ action: "resize_mode", opensMode: "resize" });
    expect(keymap.prefixed.get("w")).toEqual({ action: "navigate_mode", opensMode: "navigate" });
  });

  it("keep the keys of a mode inside the mode", () => {
    const navigate = keymap.modes.get("navigate");
    expect(navigate?.keys.get("j")).toEqual({ action: "navigate_down" });
    expect(navigate?.keys.get("down")).toEqual({ action: "navigate_down" });
    expect(navigate?.keys.get("k")).toEqual({ action: "navigate_up" });
    expect(navigate?.keys.get("up")).toEqual({ action: "navigate_up" });
    expect(navigate?.keys.has("h")).toBe(false);
    expect(navigate?.keys.has("4")).toBe(false);
    // Enter is an action of the mode (it opens the row and leaves); Esc is the only built-in way out.
    expect(navigate?.keys.get("enter")).toEqual({ action: "navigate_open", leavesMode: true });
    expect(navigate?.exits).toEqual(new Set(["esc"]));
    expect(keymap.modes.get("resize")?.exits).toEqual(new Set(["esc", "enter"]));
    expect(keymap.prefixed.has("left")).toBe(false);
  });

  it("list the live bindings of every action, in table order", () => {
    expect([...keymap.bindings.keys()]).toEqual(ACTIONS.map((action) => action.id));
    expect(keymap.bindings.get("switch_tab")).toHaveLength(9);
    expect(keymap.bindings.get("help")).toEqual([{ prefix: true, chord: chord("?") }]);
  });
});

describe("the operator's file replaces an action whole", () => {
  it("drops every default of the action", () => {
    const keymap = build({ new_tab: ["prefix+y"] });
    expect(keymap.prefixed.get("y")).toEqual({ action: "new_tab" });
    expect(keymap.prefixed.has("c")).toBe(false);
    expect(keymap.diagnostics).toEqual([]);
  });

  it("replaces a mode action too", () => {
    const keymap = build({ navigate_down: ["a"] });
    const navigate = keymap.modes.get("navigate");
    expect(navigate?.keys.get("a")).toEqual({ action: "navigate_down" });
    expect(navigate?.keys.has("j")).toBe(false);
    expect(navigate?.keys.has("down")).toBe(false);
  });

  it("unbinds with an empty list", () => {
    const keymap = build({ help: [] });
    expect(keymap.prefixed.has("?")).toBe(false);
    expect(keymap.bindings.get("help")).toEqual([]);
    expect(keymap.diagnostics).toEqual([]);
  });

  it("unbinds with an empty string", () => {
    const keymap = build({ help: [""] });
    expect(keymap.prefixed.has("?")).toBe(false);
    expect(keymap.diagnostics).toEqual([]);
  });

  it("takes a list of bindings", () => {
    const keymap = build({ switch_pane: ["prefix+g", "ctrl+k"] });
    expect(keymap.prefixed.get("g")).toEqual({ action: "switch_pane" });
    expect(keymap.direct.get("ctrl+k")).toEqual({ action: "switch_pane" });
  });

  it("keeps the unbound action's key free for another", () => {
    const keymap = build({ next_tab: [], open_dashboard: ["prefix+n"] });
    expect(keymap.prefixed.get("n")).toEqual({ action: "open_dashboard" });
    expect(keymap.diagnostics).toEqual([]);
  });
});

describe("collisions", () => {
  it("drops a default that meets the operator's binding, without a word", () => {
    const keymap = build({ open_dashboard: ["prefix+n"] });
    expect(keymap.prefixed.get("n")).toEqual({ action: "open_dashboard" });
    expect(keymap.bindings.get("next_tab")).toEqual([]);
    expect(keymap.diagnostics).toEqual([]);
  });

  it("keeps the first of two operator bindings on one key and reports the second", () => {
    const keymap = build({ open_dashboard: ["prefix+y"], settings: ["prefix+y"] });
    // `settings` comes first in the table, so it is the one kept, whatever order the file wrote.
    expect(keymap.prefixed.get("y")).toEqual({ action: "settings" });
    expect(keymap.diagnostics).toEqual([
      { action: "open_dashboard", binding: "prefix+y", code: "collision", message: "prefix+y: kept settings, disabled open_dashboard" },
    ]);
  });

  it("treats shift+/ and ? as one key", () => {
    const keymap = build({ switch_pane: ["prefix+shift+/"] });
    expect(keymap.prefixed.get("?")).toEqual({ action: "switch_pane" });
    expect(keymap.bindings.get("help")).toEqual([]);
    expect(keymap.diagnostics).toEqual([]);
  });

  it("ignores a repeat inside one action", () => {
    const keymap = build({ switch_pane: ["prefix+g", "prefix+g"] });
    expect(keymap.diagnostics).toEqual([]);
    expect(keymap.bindings.get("switch_pane")).toHaveLength(1);
  });

  it("drops one digit of a range and keeps the others", () => {
    const keymap = build({ settings: ["prefix+4"], switch_tab: ["prefix+1..9"] });
    expect(keymap.prefixed.get("4")).toEqual({ action: "settings" });
    expect(keymap.prefixed.get("5")).toEqual({ action: "switch_tab", index: 5 });
    expect(keymap.diagnostics).toHaveLength(1);
    expect(keymap.diagnostics[0].code).toBe("collision");
    expect(keymap.bindings.get("switch_tab")).toHaveLength(8);
  });

  it("reports two bindings on one key inside a mode", () => {
    const keymap = build({ navigate_down: ["a"], navigate_up: ["a"] });
    expect(keymap.modes.get("navigate")?.keys.get("a")).toEqual({ action: "navigate_down" });
    expect(codes(keymap.diagnostics)).toEqual(["collision"]);
  });

  it("lets the same key serve two modes", () => {
    const keymap = build({ navigate_down: ["h"] });
    expect(keymap.modes.get("navigate")?.keys.get("h")?.action).toBe("navigate_down");
    expect(keymap.modes.get("resize")?.keys.get("h")?.action).toBe("resize_narrower");
    expect(keymap.diagnostics).toEqual([]);
  });
});

describe("the prefix", () => {
  it("takes the operator's chord", () => {
    const keymap = build({ prefix: ["ctrl+a"] });
    expect(keymap.prefix).toEqual([chord("a", { ctrl: true })]);
    expect(keymap.prefixed.get("c")).toEqual({ action: "new_tab" });
    expect(keymap.diagnostics).toEqual([]);
  });

  it("takes several, in order", () => {
    const keymap = build({ prefix: ["ctrl+a", "ctrl+b", "ctrl+a"] });
    expect(keymap.prefix).toEqual([chord("a", { ctrl: true }), chord("b", { ctrl: true })]);
  });

  it("falls back to ctrl+b when the prefix is bad, and the rest of the file loads", () => {
    const keymap = build({ prefix: ["nonsense"], switch_pane: ["prefix+y"] });
    expect(keymap.prefix).toEqual([chord("b", { ctrl: true })]);
    expect(codes(keymap.diagnostics)).toEqual(["invalid-binding", "invalid-prefix"]);
    expect(keymap.prefixed.get("y")).toEqual({ action: "switch_pane" });
  });

  it("falls back when the prefix is emptied", () => {
    for (const prefix of [[], [""]]) {
      const keymap = build({ prefix });
      expect(keymap.prefix).toEqual([chord("b", { ctrl: true })]);
      expect(codes(keymap.diagnostics)).toContain("invalid-prefix");
    }
  });

  it("keeps the valid ones when only some are bad", () => {
    const keymap = build({ prefix: ["nonsense", "ctrl+a"] });
    expect(keymap.prefix).toEqual([chord("a", { ctrl: true })]);
    expect(codes(keymap.diagnostics)).toEqual(["invalid-binding"]);
  });

  it("refuses a prefix that would intercept typing or belongs to the browser", () => {
    expect(codes(build({ prefix: ["x"] }).diagnostics)).toEqual(["unsafe-direct", "invalid-prefix"]);
    expect(codes(build({ prefix: ["ctrl+w"] }).diagnostics)).toEqual(["browser-reserved", "invalid-prefix"]);
    expect(codes(build({ prefix: ["prefix+a"] }).diagnostics)).toEqual(["invalid-binding", "invalid-prefix"]);
    expect(codes(build({ prefix: ["1..9"] }).diagnostics)).toEqual(["range-not-indexed", "invalid-prefix"]);
  });

  it("is reserved: a binding on the prefix key is refused", () => {
    const keymap = build({ switch_pane: ["prefix+ctrl+b"], open_dashboard: ["ctrl+b"] });
    expect(keymap.prefixed.has("ctrl+b")).toBe(false);
    expect(keymap.direct.has("ctrl+b")).toBe(false);
    expect(codes(keymap.diagnostics)).toEqual(["reserved", "reserved"]);
  });

  it("drops a default on the operator's prefix key without a word", () => {
    const table: readonly ActionDef[] = [{ id: "probe", group: "global", defaults: ["prefix+ctrl+a", "prefix+x"], labelKey: "shortcuts.action.help" }];
    const keymap = buildKeymap({ defaults: table, user: { prefix: ["ctrl+a"] } });
    expect(keymap.diagnostics).toEqual([]);
    expect(keymap.prefixed.has("ctrl+a")).toBe(false);
    expect(keymap.prefixed.get("x")).toEqual({ action: "probe" });
  });

  it("is reserved inside a mode, and Esc stays the way out", () => {
    const keymap = build({ navigate_down: ["ctrl+b"], navigate_up: ["esc"], resize_wider: ["enter"] });
    expect(codes(keymap.diagnostics)).toEqual(["reserved", "reserved", "reserved"]);
    expect(keymap.modes.get("navigate")?.keys.has("esc")).toBe(false);
  });

  it("keeps Esc for cancel behind the prefix", () => {
    const keymap = build({ switch_pane: ["prefix+esc"] });
    expect(codes(keymap.diagnostics)).toEqual(["reserved"]);
  });
});

describe("direct bindings", () => {
  it("must carry a modifier: a bare or shifted printable key is refused", () => {
    for (const binding of ["x", "shift+x", "X", "?", "space", "enter", "tab", "left", "esc", "shift+tab"]) {
      const keymap = build({ switch_pane: [binding] });
      expect(codes(keymap.diagnostics), binding).toEqual(["unsafe-direct"]);
      expect(keymap.direct.size, binding).toBe(0);
    }
  });

  it("accept Ctrl, Alt or Meta, and an F key on its own", () => {
    for (const binding of ["ctrl+k", "alt+x", "cmd+k", "ctrl+shift+k", "f5", "shift+f5", "alt+left"]) {
      const keymap = build({ switch_pane: [binding] });
      expect(keymap.diagnostics, binding).toEqual([]);
      expect(keymap.direct.size, binding).toBe(1);
    }
  });

  it("refuse the chords the browser keeps", () => {
    for (const binding of ["ctrl+w", "ctrl+t", "ctrl+n", "ctrl+tab", "ctrl+shift+n", "ctrl+l", "ctrl+shift+tab", "ctrl+shift+t", "ctrl+shift+w", "cmd+w", "cmd+t", "cmd+shift+n", "cmd+shift+t", "CTRL+w"]) {
      const keymap = build({ switch_pane: [binding] });
      expect(codes(keymap.diagnostics), binding).toEqual(["browser-reserved"]);
      expect(keymap.direct.size, binding).toBe(0);
    }
  });

  it("let the browser's chords stand behind the prefix", () => {
    const keymap = build({ switch_pane: ["prefix+ctrl+w"] });
    expect(keymap.diagnostics).toEqual([]);
    expect(keymap.prefixed.get("ctrl+w")).toEqual({ action: "switch_pane" });
  });

  it("run mod as Cmd on a Mac and Ctrl elsewhere", () => {
    expect(build({ switch_pane: ["mod+k"] }, true).direct.has("meta+k")).toBe(true);
    expect(build({ switch_pane: ["mod+k"] }, false).direct.has("ctrl+k")).toBe(true);
    expect(build({ switch_pane: ["mod+w"] }, true).direct.size).toBe(0);
    expect(build({ prefix: ["mod+j"] }, true).prefix).toEqual([chord("j", { meta: true })]);
    expect(build({}, true).mac).toBe(true);
  });
});

describe("a bad binding is dropped with a diagnostic and the file still loads", () => {
  it("reports grammar errors with the action and the text", () => {
    const keymap = build({ switch_pane: ["prefix+nope"], open_dashboard: ["prefix+y"] });
    expect(keymap.diagnostics).toEqual([
      { action: "switch_pane", binding: "prefix+nope", code: "invalid-binding", message: 'prefix+nope: unknown key "nope"' },
    ]);
    expect(keymap.prefixed.get("y")).toEqual({ action: "open_dashboard" });
    expect(keymap.bindings.get("switch_pane")).toEqual([]);
  });

  it("keeps a bad binding from bringing the default back", () => {
    const keymap = build({ open_actions: ["prefix+nope"] });
    expect(keymap.prefixed.has("g")).toBe(false);
  });

  it("keeps the good bindings of one list", () => {
    const keymap = build({ switch_pane: ["prefix+nope", "prefix+y"] });
    expect(keymap.prefixed.get("y")).toEqual({ action: "switch_pane" });
    expect(codes(keymap.diagnostics)).toEqual(["invalid-binding"]);
  });

  it("refuses a range on an action that takes no number", () => {
    expect(codes(build({ switch_pane: ["prefix+1..9"] }).diagnostics)).toEqual(["range-not-indexed"]);
  });

  it("refuses a plain key on an indexed action", () => {
    const keymap = build({ switch_tab: ["prefix+x", "prefix+alt+1..9"] });
    expect(codes(keymap.diagnostics)).toEqual(["indexed-needs-digit"]);
    expect(keymap.prefixed.get("alt+3")).toEqual({ action: "switch_tab", index: 3 });
    expect(keymap.prefixed.has("1")).toBe(false);
  });

  it("refuses prefix+ inside a mode", () => {
    const keymap = build({ navigate_down: ["prefix+a"] });
    expect(codes(keymap.diagnostics)).toEqual(["prefix-in-mode"]);
    expect(keymap.modes.get("navigate")?.keys.has("a")).toBe(false);
  });

  it("reports an action the table does not have", () => {
    const keymap = build({ nonsense: ["prefix+y", "ctrl+k"], switch_pane: ["prefix+g"] });
    expect(keymap.diagnostics).toEqual([
      { action: "nonsense", binding: "prefix+y, ctrl+k", code: "unknown-action", message: "nonsense is not an action" },
    ]);
    expect(keymap.prefixed.has("y")).toBe(false);
  });

  it("does not trust a name that looks like an object method", () => {
    const user: UserShortcuts = JSON.parse('{"constructor":["prefix+y"],"__proto__":["x"]}');
    const keymap = build(user);
    expect(keymap.diagnostics.map((diagnostic) => diagnostic.action)).toEqual(["constructor", "__proto__"]);
    expect(keymap.prefixed.get("g")).toEqual({ action: "open_actions" });
  });
});

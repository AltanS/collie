import { describe, expect, it } from "vitest";

import { ACTIONS } from "./actions";
import { buildKeymap } from "./keymap";
import { createResolver } from "./resolve";
import type { KeyLike, UserShortcuts } from "./types";

function codeFor(key: string): string {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return key;
}

/** One key tap. `code` follows the key unless a case names a different physical key. */
function tap(key: string, init: Partial<KeyLike> = {}): KeyLike {
  return {
    key,
    code: codeFor(key),
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 0,
    altGraph: false,
    ...init,
  };
}

const ctrl = (key: string, init: Partial<KeyLike> = {}): KeyLike => tap(key, { ctrlKey: true, ...init });

function make(user?: UserShortcuts, mac = false) {
  const keymap = buildKeymap({ defaults: ACTIONS, user, mac });
  expect(keymap.diagnostics).toEqual([]);
  return createResolver(keymap);
}

const PASS = { type: "pass" };
const SWALLOW = { type: "swallow" };

describe("the normal mode", () => {
  it("leaves every ordinary key alone", () => {
    const resolver = make();
    for (const event of [tap("a"), tap("A", { shiftKey: true }), tap("Enter"), tap("Escape"), tap("Tab"), tap(" "), ctrl("c"), ctrl("r"), tap("ArrowLeft"), tap("c", { metaKey: true })]) {
      expect(resolver.press(event)).toEqual(PASS);
    }
    expect(resolver.mode).toBe("normal");
  });

  it("enters the prefix on ctrl+b", () => {
    const resolver = make();
    expect(resolver.press(ctrl("b"))).toEqual({ type: "enter-prefix" });
    expect(resolver.mode).toBe("prefix");
  });

  it("runs a direct binding and never enters a mode", () => {
    const resolver = make({ zen_mode: ["ctrl+shift+z"], find: ["f3"] });
    expect(resolver.press(ctrl("Z", { shiftKey: true }))).toEqual({ type: "run", action: "zen_mode" });
    expect(resolver.press(tap("F3"))).toEqual({ type: "run", action: "find" });
    expect(resolver.mode).toBe("normal");
  });

  it("opens a sticky mode from a direct binding", () => {
    const resolver = make({ resize_mode: ["alt+r"] });
    expect(resolver.press(tap("r", { altKey: true }))).toEqual({ type: "mode", id: "resize" });
    expect(resolver.mode).toBe("resize");
  });

  it("does not run a prefix binding without the prefix", () => {
    expect(make().press(tap("c"))).toEqual(PASS);
  });
});

describe("the prefix mode", () => {
  it("runs a match and returns to normal", () => {
    const resolver = make();
    resolver.press(ctrl("b"));
    expect(resolver.press(tap("c"))).toEqual({ type: "run", action: "new_tab" });
    expect(resolver.mode).toBe("normal");
    expect(resolver.press(tap("c"))).toEqual(PASS);
  });

  it("sends the prefix when it is pressed twice", () => {
    const resolver = make();
    resolver.press(ctrl("b"));
    expect(resolver.press(ctrl("b"))).toEqual({ type: "send-prefix", chord: { key: "b", ctrl: true, shift: false, alt: false, meta: false } });
    expect(resolver.mode).toBe("normal");
  });

  it("cancels on Esc", () => {
    const resolver = make();
    resolver.press(ctrl("b"));
    expect(resolver.press(tap("Escape"))).toEqual({ type: "cancel" });
    expect(resolver.mode).toBe("normal");
  });

  it("swallows an unmatched key and returns to normal", () => {
    const resolver = make();
    resolver.press(ctrl("b"));
    expect(resolver.press(tap("="))).toEqual(SWALLOW);
    expect(resolver.mode).toBe("normal");
    expect(resolver.press(tap("="))).toEqual(PASS);
  });

  it("swallows a chord the prefix table does not have, such as a held ctrl", () => {
    const resolver = make();
    resolver.press(ctrl("b"));
    expect(resolver.press(ctrl("c"))).toEqual(SWALLOW);
  });

  it("matches an uppercase letter as Shift plus the letter", () => {
    const resolver = make();
    resolver.press(ctrl("b"));
    expect(resolver.press(tap("N", { shiftKey: true }))).toEqual({ type: "run", action: "new_space" });
    resolver.press(ctrl("b"));
    expect(resolver.press(tap("n"))).toEqual({ type: "run", action: "next_tab" });
  });

  it("matches shift+tab and tab apart", () => {
    const resolver = make();
    resolver.press(ctrl("b"));
    expect(resolver.press(tap("Tab", { shiftKey: true }))).toEqual({ type: "run", action: "cycle_pane_previous" });
    resolver.press(ctrl("b"));
    expect(resolver.press(tap("Tab"))).toEqual({ type: "run", action: "cycle_pane_next" });
  });

  it("numbers the tabs", () => {
    const resolver = make();
    resolver.press(ctrl("b"));
    expect(resolver.press(tap("5"))).toEqual({ type: "run", action: "switch_tab", index: 5 });
  });

  it("reaches an indexed tab with the shifted digit of a French layout", () => {
    const resolver = make();
    resolver.press(ctrl("b"));
    expect(resolver.press(tap("5", { shiftKey: true, code: "Digit5" }))).toEqual({ type: "run", action: "switch_tab", index: 5 });
  });
});

describe("a shifted symbol", () => {
  it("matches the binding written ?", () => {
    const resolver = make();
    resolver.press(ctrl("b"));
    expect(resolver.press(tap("?", { shiftKey: true, code: "Slash" }))).toEqual({ type: "run", action: "help" });
  });

  it("matches the binding written shift+/", () => {
    const resolver = make({ help: ["prefix+shift+/"] });
    resolver.press(ctrl("b"));
    expect(resolver.press(tap("?", { shiftKey: true, code: "Slash" }))).toEqual({ type: "run", action: "help" });
  });

  it("takes a slash held with Shift as the shifted binding when nothing else claims it", () => {
    const resolver = make({ help: ["ctrl+shift+/"] });
    expect(resolver.press(ctrl("/", { shiftKey: true }))).toEqual({ type: "run", action: "help" });
  });

  it("is the slash itself where the layout types it with Shift", () => {
    const resolver = make();
    resolver.press(ctrl("b"));
    expect(resolver.press(tap("/", { shiftKey: true, code: "Digit7" }))).toEqual({ type: "run", action: "find" });
  });

  it("does not match the unshifted key", () => {
    const resolver = make();
    resolver.press(ctrl("b"));
    expect(resolver.press(tap("/"))).toEqual({ type: "run", action: "find" });
  });

  it("matches a direct binding with a modifier", () => {
    const resolver = make({ help: ["ctrl+?"] });
    expect(resolver.press(ctrl("?", { shiftKey: true }))).toEqual({ type: "run", action: "help" });
  });
});

describe("a held key", () => {
  it("does not toggle the prefix in and out", () => {
    const resolver = make();
    expect(resolver.press(ctrl("b"))).toEqual({ type: "enter-prefix" });
    expect(resolver.press(ctrl("b", { repeat: true }))).toEqual(SWALLOW);
    expect(resolver.press(ctrl("b", { repeat: true }))).toEqual(SWALLOW);
    expect(resolver.mode).toBe("prefix");
    expect(resolver.press(tap("c"))).toEqual({ type: "run", action: "new_tab" });
  });

  it("does not enter the prefix from a repeat in the normal mode", () => {
    const resolver = make();
    expect(resolver.press(ctrl("b", { repeat: true }))).toEqual(SWALLOW);
    expect(resolver.mode).toBe("normal");
  });

  it("does not open the prefix from a repeat inside a sticky mode", () => {
    const resolver = make();
    resolver.press(ctrl("b"));
    resolver.press(tap("r"));
    expect(resolver.press(ctrl("b", { repeat: true }))).toEqual(SWALLOW);
    expect(resolver.mode).toBe("resize");
  });

  it("repeats a sticky mode's own key", () => {
    const resolver = make();
    resolver.press(ctrl("b"));
    resolver.press(tap("r"));
    expect(resolver.press(tap("l", { repeat: true }))).toEqual({ type: "run", action: "resize_wider" });
  });
});

describe("keys that are not a choice", () => {
  it("passes while an IME composes, and does not change the mode", () => {
    const resolver = make();
    expect(resolver.press(ctrl("b", { isComposing: true }))).toEqual(PASS);
    expect(resolver.press(ctrl("b", { keyCode: 229 }))).toEqual(PASS);
    expect(resolver.mode).toBe("normal");
    resolver.press(ctrl("b"));
    expect(resolver.press(tap("c", { isComposing: true }))).toEqual(PASS);
    expect(resolver.press(tap("Process", { keyCode: 229 }))).toEqual(PASS);
    expect(resolver.mode).toBe("prefix");
  });

  it("passes a modifier on its own in every mode and keeps the prefix open", () => {
    const resolver = make();
    for (const key of ["Control", "Shift", "Alt", "Meta"]) expect(resolver.press(tap(key))).toEqual(PASS);
    resolver.press(ctrl("b"));
    for (const key of ["Control", "Shift", "Alt", "Meta", "AltGraph"]) expect(resolver.press(tap(key))).toEqual(PASS);
    expect(resolver.mode).toBe("prefix");
    resolver.press(tap("r"));
    expect(resolver.mode).toBe("resize");
    for (const key of ["Control", "Shift", "Alt", "Meta"]) expect(resolver.press(tap(key))).toEqual(PASS);
    expect(resolver.mode).toBe("resize");
  });

  it("passes a dead key without closing the prefix", () => {
    const resolver = make();
    resolver.press(ctrl("b"));
    expect(resolver.press(tap("Dead"))).toEqual(PASS);
    expect(resolver.mode).toBe("prefix");
  });
});

describe("the layout", () => {
  it("matches ctrl+b on a German layout by its key", () => {
    expect(make().press(ctrl("b", { code: "KeyB" }))).toEqual({ type: "enter-prefix" });
  });

  it("matches ctrl+b on a Cyrillic layout by its physical key", () => {
    const resolver = make();
    expect(resolver.press(ctrl("и", { code: "KeyB" }))).toEqual({ type: "enter-prefix" });
    expect(resolver.mode).toBe("prefix");
  });

  it("matches a ctrl digit by its physical key", () => {
    const resolver = make({ switch_pane: ["ctrl+1"] });
    expect(resolver.press(ctrl("٣", { code: "Digit1" }))).toEqual({ type: "run", action: "switch_pane" });
  });

  it("matches an alt letter by its physical key on a Mac, where Option types a symbol", () => {
    const resolver = make({ switch_pane: ["alt+b"] }, true);
    expect(resolver.press(tap("∫", { code: "KeyB", altKey: true }))).toEqual({ type: "run", action: "switch_pane" });
  });

  it("does not move a key a Latin layout already named", () => {
    // Dvorak: the physical KeyB types `x`. `ctrl+x` is `ctrl+x`, not the prefix.
    expect(make().press(ctrl("x", { code: "KeyB" }))).toEqual(PASS);
  });

  it("prefers the key over the physical key", () => {
    const resolver = make({ switch_pane: ["ctrl+x"] });
    expect(resolver.press(ctrl("x", { code: "KeyB" }))).toEqual({ type: "run", action: "switch_pane" });
  });

  it("retries the physical key for a ctrl-only or alt-only chord and nothing else", () => {
    const resolver = make({ switch_pane: ["ctrl+shift+k"], open_dashboard: ["ctrl+alt+j"], zen_mode: ["cmd+k"], find: ["ctrl+k"] });
    expect(resolver.press(ctrl("к", { code: "KeyK", shiftKey: true }))).toEqual(PASS);
    expect(resolver.press(ctrl("о", { code: "KeyJ", altKey: true }))).toEqual(PASS);
    expect(resolver.press(tap("к", { code: "KeyK", metaKey: true }))).toEqual(PASS);
    expect(resolver.press(ctrl("к", { code: "KeyK" }))).toEqual({ type: "run", action: "find" });
  });

  it("uses the physical key for a bare key behind the prefix on a Cyrillic layout", () => {
    const resolver = make();
    resolver.press(ctrl("b"));
    expect(resolver.press(tap("с", { code: "KeyC" }))).toEqual({ type: "run", action: "new_tab" });
    expect(resolver.mode).toBe("normal");
  });

  it("uses the physical digit behind the prefix", () => {
    const resolver = make();
    resolver.press(ctrl("b"));
    expect(resolver.press(tap("٤", { code: "Digit4" }))).toEqual({ type: "run", action: "switch_tab", index: 4 });
  });

  it("matches a bare key behind the prefix by its key on a Dvorak layout", () => {
    // Dvorak: the physical KeyC types `j`. `prefix j` is next_space, not new_tab.
    const resolver = make();
    resolver.press(ctrl("b"));
    expect(resolver.press(tap("j", { code: "KeyC" }))).toEqual({ type: "run", action: "next_space" });
    resolver.press(ctrl("b"));
    expect(resolver.press(tap("z", { code: "KeyC" }))).toEqual({ type: "run", action: "zen_mode" });
  });

  it("does not use the physical key for a bare key an ASCII layout typed, behind the prefix", () => {
    const resolver = make();
    resolver.press(ctrl("b"));
    expect(resolver.press(tap("y", { code: "KeyC" }))).toEqual(SWALLOW);
  });

  it("uses the physical key for a bare key inside a sticky mode on a Cyrillic layout", () => {
    const resolver = make();
    resolver.press(ctrl("b"));
    resolver.press(tap("r"));
    expect(resolver.press(tap("д", { code: "KeyL" }))).toEqual({ type: "run", action: "resize_wider" });
    expect(resolver.mode).toBe("resize");
  });

  it("never uses the physical key for a bare key in the normal mode, where it is typing", () => {
    const resolver = make({ switch_pane: ["f3"] });
    expect(resolver.press(tap("с", { code: "KeyC" }))).toEqual(PASS);
    expect(resolver.press(tap("и", { code: "KeyB" }))).toEqual(PASS);
    expect(resolver.mode).toBe("normal");
  });

  it("does not retry the physical key for a shifted bare key", () => {
    const resolver = make();
    resolver.press(ctrl("b"));
    expect(resolver.press(tap("С", { code: "KeyC", shiftKey: true }))).toEqual(SWALLOW);
  });
});

describe("AltGr", () => {
  it("never fires a ctrl+alt chord on a character typed with AltGr", () => {
    const resolver = make({ switch_pane: ["ctrl+alt+q"] });
    // A German keyboard types `@` with AltGr+Q. Windows reports it as ctrl+alt and sets AltGraph.
    expect(resolver.press(tap("@", { code: "KeyQ", ctrlKey: true, altKey: true, altGraph: true }))).toEqual(PASS);
    expect(resolver.mode).toBe("normal");
  });

  it("fires the same chord on a US layout, where there is no AltGr", () => {
    const resolver = make({ switch_pane: ["ctrl+alt+q"] });
    expect(resolver.press(tap("q", { ctrlKey: true, altKey: true }))).toEqual({ type: "run", action: "switch_pane" });
  });

  it("reads an AltGr character as itself behind the prefix", () => {
    const resolver = make({ switch_pane: ["prefix+@"] });
    resolver.press(ctrl("b"));
    expect(resolver.press(tap("@", { code: "KeyQ", ctrlKey: true, altKey: true, altGraph: true }))).toEqual({ type: "run", action: "switch_pane" });
  });

  it("reads an AltGr character as itself when the system reports only AltGraph", () => {
    const resolver = make({ switch_pane: ["prefix+@"] });
    resolver.press(ctrl("b"));
    expect(resolver.press(tap("@", { code: "KeyQ", altKey: true, altGraph: true }))).toEqual({ type: "run", action: "switch_pane" });
  });
});

describe("a Mac's Cmd", () => {
  it("is the meta key", () => {
    const resolver = make({ switch_pane: ["cmd+k"] }, true);
    expect(resolver.press(tap("k", { metaKey: true }))).toEqual({ type: "run", action: "switch_pane" });
    expect(resolver.press(ctrl("k"))).toEqual(PASS);
  });

  it("is what mod means", () => {
    const resolver = make({ switch_pane: ["mod+k"] }, true);
    expect(resolver.press(tap("k", { metaKey: true }))).toEqual({ type: "run", action: "switch_pane" });
  });

  it("can be the prefix", () => {
    const resolver = make({ prefix: ["cmd+j"] }, true);
    expect(resolver.press(tap("j", { metaKey: true }))).toEqual({ type: "enter-prefix" });
    expect(resolver.press(tap("c"))).toEqual({ type: "run", action: "new_tab" });
  });
});

describe("the prefix list", () => {
  it("enters on any prefix and sends the one that was pressed", () => {
    const resolver = make({ prefix: ["ctrl+a", "ctrl+b"] });
    resolver.press(ctrl("b"));
    expect(resolver.press(ctrl("b"))).toMatchObject({ type: "send-prefix", chord: { key: "b" } });
    resolver.press(ctrl("a"));
    expect(resolver.press(ctrl("a"))).toMatchObject({ type: "send-prefix", chord: { key: "a" } });
  });
});

describe("a sticky mode", () => {
  function inMode(user?: UserShortcuts, opener = "r") {
    const resolver = make(user);
    resolver.press(ctrl("b"));
    resolver.press(tap(opener));
    return resolver;
  }

  it("is opened by its prefix binding", () => {
    const resolver = make();
    resolver.press(ctrl("b"));
    expect(resolver.press(tap("r"))).toEqual({ type: "mode", id: "resize" });
    expect(resolver.mode).toBe("resize");
    expect(resolver.sticky).toBe("resize");
  });

  it("runs its own keys and stays", () => {
    const resolver = inMode();
    expect(resolver.press(tap("l"))).toEqual({ type: "run", action: "resize_wider" });
    expect(resolver.press(tap("ArrowLeft"))).toEqual({ type: "run", action: "resize_narrower" });
    expect(resolver.press(tap("h"))).toEqual({ type: "run", action: "resize_narrower" });
    expect(resolver.mode).toBe("resize");
  });

  it("swallows a bare, shifted or alt key it does not know", () => {
    const resolver = inMode();
    expect(resolver.press(tap("x"))).toEqual(SWALLOW);
    expect(resolver.press(tap("X", { shiftKey: true }))).toEqual(SWALLOW);
    expect(resolver.press(tap("Enter", { shiftKey: true }))).toEqual(SWALLOW);
    expect(resolver.press(tap("x", { altKey: true }))).toEqual(SWALLOW);
    expect(resolver.mode).toBe("resize");
  });

  it("passes a Ctrl or Meta chord it does not know, so ctrl+c and cmd+r keep working", () => {
    const resolver = inMode({ zen_mode: ["ctrl+shift+z"] });
    expect(resolver.press(ctrl("c"))).toEqual(PASS);
    expect(resolver.press(tap("r", { metaKey: true }))).toEqual(PASS);
    expect(resolver.press(ctrl("Z", { shiftKey: true }))).toEqual(PASS);
    expect(resolver.mode).toBe("resize");
  });

  it("still treats the prefix and a mode key with a modifier as its own", () => {
    const resolver = inMode({ resize_wider: ["alt+l"] });
    expect(resolver.press(tap("l", { altKey: true }))).toEqual({ type: "run", action: "resize_wider" });
    expect(resolver.press(ctrl("b"))).toEqual({ type: "enter-prefix" });
  });

  it("leaves on Esc in both modes, and on Enter in Resize", () => {
    for (const opener of ["r", "w"]) {
      const byEsc = inMode(undefined, opener);
      expect(byEsc.press(tap("Escape"))).toEqual({ type: "leave-mode" });
      expect(byEsc.mode).toBe("normal");
      expect(byEsc.sticky).toBeNull();
    }
    const byEnter = inMode(undefined, "r");
    expect(byEnter.press(tap("Enter"))).toEqual({ type: "leave-mode" });
    expect(byEnter.mode).toBe("normal");
    expect(byEnter.sticky).toBeNull();
  });

  it("runs Enter in Navigate as an action and leaves the mode with it", () => {
    const resolver = inMode(undefined, "w");
    expect(resolver.press(tap("Enter"))).toEqual({ type: "run", action: "navigate_open" });
    expect(resolver.mode).toBe("normal");
    expect(resolver.sticky).toBeNull();
  });

  it("does not leave the navigate mode on a key it did not name", () => {
    const resolver = inMode(undefined, "w");
    expect(resolver.press(tap("Backspace"))).toEqual(SWALLOW);
    expect(resolver.mode).toBe("navigate");
  });

  it("opens the prefix over it and returns to it", () => {
    const resolver = inMode();
    expect(resolver.press(ctrl("b"))).toEqual({ type: "enter-prefix" });
    expect(resolver.mode).toBe("prefix");
    expect(resolver.sticky).toBe("resize");
    expect(resolver.press(tap("c"))).toEqual({ type: "run", action: "new_tab" });
    expect(resolver.mode).toBe("resize");
  });

  it("returns to it after a cancel, a swallow and a literal prefix", () => {
    const resolver = inMode();
    resolver.press(ctrl("b"));
    expect(resolver.press(tap("Escape"))).toEqual({ type: "cancel" });
    expect(resolver.mode).toBe("resize");
    resolver.press(ctrl("b"));
    expect(resolver.press(tap("="))).toEqual(SWALLOW);
    expect(resolver.mode).toBe("resize");
    resolver.press(ctrl("b"));
    expect(resolver.press(ctrl("b"))).toMatchObject({ type: "send-prefix" });
    expect(resolver.mode).toBe("resize");
  });

  it("switches to the other mode when the prefix opens it", () => {
    const resolver = inMode();
    resolver.press(ctrl("b"));
    expect(resolver.press(tap("w"))).toEqual({ type: "mode", id: "navigate" });
    expect(resolver.mode).toBe("navigate");
    expect(resolver.press(tap("k"))).toEqual({ type: "run", action: "navigate_up" });
  });

  it("runs the navigate move keys live, and stays", () => {
    const resolver = inMode(undefined, "w");
    expect(resolver.press(tap("j"))).toEqual({ type: "run", action: "navigate_down" });
    expect(resolver.press(tap("ArrowUp"))).toEqual({ type: "run", action: "navigate_up" });
    expect(resolver.press(tap("h"))).toEqual(SWALLOW);
    expect(resolver.press(tap("3"))).toEqual(SWALLOW);
    expect(resolver.mode).toBe("navigate");
  });

  it("takes the operator's keys", () => {
    const resolver = inMode({ resize_wider: ["w"] });
    expect(resolver.press(tap("w"))).toEqual({ type: "run", action: "resize_wider" });
    expect(resolver.press(tap("l"))).toEqual(SWALLOW);
  });
});

describe("reset", () => {
  it("goes back to normal from the prefix and from a sticky mode", () => {
    const resolver = make();
    resolver.press(ctrl("b"));
    resolver.press(tap("r"));
    resolver.press(ctrl("b"));
    expect(resolver.mode).toBe("prefix");
    resolver.reset();
    expect(resolver.mode).toBe("normal");
    expect(resolver.sticky).toBeNull();
    expect(resolver.press(tap("l"))).toEqual(PASS);
  });

  it("cancelPrefix ends a pending prefix and keeps the sticky mode under it", () => {
    const resolver = make();
    resolver.press(ctrl("b"));
    resolver.press(tap("r"));
    resolver.press(ctrl("b"));
    resolver.cancelPrefix();
    expect(resolver.mode).toBe("resize");
    expect(resolver.press(tap("l"))).toEqual({ type: "run", action: "resize_wider" });
  });

  it("cancelPrefix in the normal mode changes nothing", () => {
    const resolver = make();
    resolver.cancelPrefix();
    expect(resolver.mode).toBe("normal");
  });
});

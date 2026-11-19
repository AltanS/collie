import { describe, expect, it } from "vitest";

import { bindingKeycaps, chordKeycaps, formatBinding, parseBinding, type ParseOptions } from "./parse";
import type { Binding, Chord } from "./types";

function one(text: string, options?: ParseOptions): Binding {
  const parsed = parseBinding(text, options);
  if (!parsed.ok) throw new Error(`${text}: ${parsed.error.message}`);
  expect(parsed.bindings).toHaveLength(1);
  return parsed.bindings[0];
}

function many(text: string, options?: ParseOptions): readonly Binding[] {
  const parsed = parseBinding(text, options);
  if (!parsed.ok) throw new Error(`${text}: ${parsed.error.message}`);
  return parsed.bindings;
}

function codeOf(text: string, options?: ParseOptions): string | null {
  const parsed = parseBinding(text, options);
  return parsed.ok ? null : parsed.error.code;
}

function chord(key: string, mods: Partial<Omit<Chord, "key">> = {}): Chord {
  return { key, ctrl: false, shift: false, alt: false, meta: false, ...mods };
}

describe("parseBinding: modifiers", () => {
  it.each([
    ["ctrl+b", chord("b", { ctrl: true })],
    ["control+b", chord("b", { ctrl: true })],
    ["shift+tab", chord("tab", { shift: true })],
    ["alt+b", chord("b", { alt: true })],
    ["option+b", chord("b", { alt: true })],
    ["meta+b", chord("b", { alt: true })],
    ["cmd+b", chord("b", { meta: true })],
    ["command+b", chord("b", { meta: true })],
    ["super+b", chord("b", { meta: true })],
    ["CTRL+Shift+ALT+b", chord("b", { ctrl: true, shift: true, alt: true })],
    ["ctrl+ctrl+b", chord("b", { ctrl: true })],
  ])("%s", (text, expected) => {
    expect(one(text).chord).toEqual(expected);
    expect(one(text).prefix).toBe(false);
  });

  it("reads mod as Cmd on a Mac and Ctrl elsewhere", () => {
    expect(one("mod+k", { mac: true }).chord).toEqual(chord("k", { meta: true }));
    expect(one("mod+k", { mac: false }).chord).toEqual(chord("k", { ctrl: true }));
    expect(one("mod+k").chord).toEqual(chord("k", { ctrl: true }));
  });

  it("is case-insensitive for the prefix word too", () => {
    expect(one("PREFIX+c")).toEqual({ prefix: true, chord: chord("c") });
  });
});

describe("parseBinding: keys", () => {
  it.each([
    ["space", "space"],
    ["enter", "enter"],
    ["return", "enter"],
    ["esc", "esc"],
    ["escape", "esc"],
    ["tab", "tab"],
    ["backspace", "backspace"],
    ["bs", "backspace"],
    ["left", "left"],
    ["right", "right"],
    ["up", "up"],
    ["down", "down"],
    ["minus", "-"],
    ["comma", ","],
    ["period", "."],
    ["slash", "/"],
    ["backslash", "\\"],
    ["quote", "'"],
    ["double_quote", '"'],
    ["double-quote", '"'],
    ["semicolon", ";"],
    ["colon", ":"],
    ["percent", "%"],
    ["ampersand", "&"],
    ["backtick", "`"],
    ["plus", "+"],
    ["SPACE", "space"],
  ])("names %s", (name, key) => {
    expect(one(`ctrl+${name}`).chord).toEqual(chord(key, { ctrl: true }));
  });

  it("reads f1 to f12 and nothing past them", () => {
    for (let n = 1; n <= 12; n += 1) expect(one(`ctrl+f${n}`).chord.key).toBe(`f${n}`);
    expect(codeOf("ctrl+f13")).toBe("invalid-binding");
    expect(codeOf("ctrl+f0")).toBe("invalid-binding");
  });

  it("reads one character, including a non-Latin one", () => {
    expect(one("ctrl+ö").chord).toEqual(chord("ö", { ctrl: true }));
    expect(one("prefix+и").chord).toEqual(chord("и"));
    expect(one("prefix+7").chord).toEqual(chord("7"));
  });

  it("reads a literal plus as ++, plus, or a lone +", () => {
    expect(one("ctrl++").chord).toEqual(chord("+", { ctrl: true }));
    expect(one("ctrl+shift++").chord).toEqual(chord("+", { ctrl: true }));
    expect(one("ctrl+plus").chord).toEqual(chord("+", { ctrl: true }));
    expect(one("+").chord).toEqual(chord("+"));
    expect(one("prefix++")).toEqual({ prefix: true, chord: chord("+") });
  });

  it("adds Shift for an upper-case letter", () => {
    expect(one("N").chord).toEqual(chord("n", { shift: true }));
    expect(one("prefix+N")).toEqual({ prefix: true, chord: chord("n", { shift: true }) });
    expect(one("shift+N").chord).toEqual(one("shift+n").chord);
    expect(one("ctrl+B").chord).toEqual(chord("b", { ctrl: true, shift: true }));
  });

  it("folds a shifted symbol into the symbol it types", () => {
    const question = chord("?");
    expect(one("?").chord).toEqual(question);
    expect(one("shift+/").chord).toEqual(question);
    expect(one("shift+slash").chord).toEqual(question);
    expect(one("ctrl+shift+/").chord).toEqual(chord("?", { ctrl: true }));
    expect(one("shift+1").chord).toEqual(chord("!"));
    expect(one("shift+?").chord).toEqual(question);
  });

  it("keeps Shift on a key that types no symbol", () => {
    expect(one("shift+tab").chord).toEqual(chord("tab", { shift: true }));
    expect(one("shift+f5").chord).toEqual(chord("f5", { shift: true }));
  });
});

describe("parseBinding: prefix form", () => {
  it("marks a prefix binding", () => {
    expect(one("prefix+shift+n")).toEqual({ prefix: true, chord: chord("n", { shift: true }) });
    expect(one("prefix+ctrl+b")).toEqual({ prefix: true, chord: chord("b", { ctrl: true }) });
  });

  it("trims the text and its parts", () => {
    expect(one("  prefix + ctrl + b  ")).toEqual({ prefix: true, chord: chord("b", { ctrl: true }) });
  });
});

describe("parseBinding: ranges", () => {
  it("expands 1..9 for an indexed action, with the number", () => {
    const bindings = many("prefix+1..9", { indexed: true });
    expect(bindings.map((binding) => binding.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(bindings.map((binding) => binding.chord.key)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(bindings.every((binding) => binding.prefix)).toBe(true);
  });

  it("applies the modifiers to every digit", () => {
    const bindings = many("alt+1..9", { indexed: true });
    expect(bindings.every((binding) => binding.chord.alt && !binding.prefix)).toBe(true);
    expect(many("1..9+alt", { indexed: true })).toEqual(bindings);
  });

  it("keeps the number when Shift folds the digit into a symbol", () => {
    const bindings = many("shift+1..9", { indexed: true });
    expect(bindings[0]).toEqual({ prefix: false, chord: chord("!"), index: 1 });
    expect(bindings[8].index).toBe(9);
  });

  it("refuses a range for an action that takes no number", () => {
    expect(codeOf("prefix+1..9")).toBe("range-not-indexed");
    expect(codeOf("alt+1..9", { indexed: false })).toBe("range-not-indexed");
  });

  it("takes one digit for an indexed action and refuses any other key", () => {
    expect(one("prefix+3", { indexed: true })).toEqual({ prefix: true, chord: chord("3"), index: 3 });
    expect(codeOf("prefix+x", { indexed: true })).toBe("indexed-needs-digit");
    expect(codeOf("prefix+0", { indexed: true })).toBe("indexed-needs-digit");
    expect(codeOf("prefix+tab", { indexed: true })).toBe("indexed-needs-digit");
  });

  it("leaves a digit alone for an action that takes no number", () => {
    expect(one("prefix+3")).toEqual({ prefix: true, chord: chord("3") });
  });

  it("refuses a range beside another key or a second range", () => {
    expect(codeOf("1..9+x", { indexed: true })).toBe("invalid-binding");
    expect(codeOf("x+1..9", { indexed: true })).toBe("invalid-binding");
    expect(codeOf("1..9+1..9", { indexed: true })).toBe("invalid-binding");
  });
});

describe("parseBinding: errors", () => {
  it.each([
    ["", "the binding is empty"],
    ["   ", "the binding is empty"],
    ["prefix+", "an empty part"],
    ["ctrl+", "an empty part"],
    ["ctrl++b", "an empty part"],
    ["ctrl+shift", "no key"],
    ["ctrl+ctrl", "no key"],
    ["a+b", "more than one key"],
    ["ctrl+a+b", "more than one key"],
    ["ctrl+nope", 'unknown key "nope"'],
    ["prefix", 'unknown key "prefix"'],
    ["hyper+a", "more than one key"],
  ])("refuses %j", (text, reason) => {
    const parsed = parseBinding(text);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe("invalid-binding");
    expect(parsed.error.message).toContain(reason);
  });
});

describe("printing", () => {
  const prefix = chord("b", { ctrl: true });

  it("prints the prefix as the configured chord, not as the word", () => {
    expect(formatBinding(one("prefix+c"), { mac: false, prefix })).toBe("Ctrl B c");
    expect(formatBinding(one("prefix+shift+n"), { mac: false, prefix })).toBe("Ctrl B Shift N");
    expect(formatBinding(one("prefix+?"), { mac: false, prefix: chord("a", { ctrl: true }) })).toBe("Ctrl A ?");
  });

  it("prints a direct binding on its own", () => {
    expect(formatBinding(one("ctrl+shift+r"), { mac: false, prefix })).toBe("Ctrl Shift R");
    expect(formatBinding(one("f5"), { mac: false, prefix })).toBe("F5");
  });

  it("prints the meta modifier as Cmd on a Mac and Meta elsewhere", () => {
    expect(formatBinding(one("cmd+k"), { mac: true, prefix })).toBe("Cmd K");
    expect(formatBinding(one("cmd+k"), { mac: false, prefix })).toBe("Meta K");
  });

  it("prints Alt as Option on a Mac", () => {
    expect(formatBinding(one("alt+k"), { mac: true, prefix })).toBe("Option K");
    expect(formatBinding(one("alt+k"), { mac: false, prefix })).toBe("Alt K");
  });

  it("names the special keys", () => {
    expect(formatBinding(one("prefix+tab"), { mac: false, prefix })).toBe("Ctrl B Tab");
    expect(formatBinding(one("prefix+shift+tab"), { mac: false, prefix })).toBe("Ctrl B Shift Tab");
    expect(formatBinding(one("prefix+space"), { mac: false, prefix })).toBe("Ctrl B Space");
    expect(formatBinding(one("left"), { mac: false, prefix })).toBe("Left");
    expect(formatBinding(one("prefix+esc"), { mac: false, prefix })).toBe("Ctrl B Esc");
  });

  it("gives the key caps as a list for the UI", () => {
    expect(bindingKeycaps(one("prefix+c"), { mac: false, prefix })).toEqual(["Ctrl", "B", "c"]);
    expect(chordKeycaps({ chord: prefix, mac: false })).toEqual(["Ctrl", "B"]);
  });
});

import { describe, expect, test } from "bun:test";

import { canonicalMuxKey, formatMuxKey, isMuxKey, MUX_NAMED_KEYS, parseMuxKey } from "./keys.ts";

// The contract owns ONE key spelling because the three multiplexers own three (Herdr `ctrl+c`,
// tmux `C-c`, zellij `"Ctrl c"`). These pin what an adapter's translation table can rely on:
// canonical modifier order, a closed key alphabet, and a parse that refuses rather than guesses.

describe("parseMuxKey", () => {
  test("a bare named key", () => {
    expect(parseMuxKey("Escape")).toEqual({ modifiers: [], key: "Escape" });
  });

  test("a single literal character, case preserved", () => {
    expect(parseMuxKey("a")).toEqual({ modifiers: [], key: "a" });
    expect(parseMuxKey("A")).toEqual({ modifiers: [], key: "A" });
    expect(parseMuxKey("1")).toEqual({ modifiers: [], key: "1" });
  });

  test("a chord", () => {
    expect(parseMuxKey("ctrl+c")).toEqual({ modifiers: ["ctrl"], key: "c" });
    expect(parseMuxKey("shift+Tab")).toEqual({ modifiers: ["shift"], key: "Tab" });
  });

  test("input casing is forgiving on names and modifiers; output never is", () => {
    expect(canonicalMuxKey("CTRL+escape")).toBe("ctrl+Escape");
    expect(canonicalMuxKey("Shift+TAB")).toBe("shift+Tab");
  });

  // `+` is a key you can send, so it must survive being the join character too.
  test("the plus key", () => {
    expect(parseMuxKey("+")).toEqual({ modifiers: [], key: "+" });
    expect(parseMuxKey("ctrl++")).toEqual({ modifiers: ["ctrl"], key: "+" });
  });

  test.each(["", "ctrl+", "ctrl", "meta+Nope", "Ctrl c", "C-c", "ctrl+ctrl+c", "hyper+c"])(
    "refuses %p rather than guessing",
    (spelling) => {
      expect(parseMuxKey(spelling)).toBeNull();
      expect(isMuxKey(spelling)).toBe(false);
    },
  );

  // Two spellings of one chord must never survive as two strings — an adapter's translation table
  // would otherwise need a row per permutation, and a test comparing sent keys would be a coin toss.
  test("modifier order is canonical, not the operator's", () => {
    expect(canonicalMuxKey("shift+ctrl+p")).toBe("ctrl+shift+p");
    expect(canonicalMuxKey("shift+alt+ctrl+meta+p")).toBe("ctrl+alt+shift+meta+p");
    expect(canonicalMuxKey("meta+ctrl+Up")).toBe("ctrl+meta+Up");
  });
});

describe("the alphabet", () => {
  test("every named key parses and round-trips", () => {
    for (const name of MUX_NAMED_KEYS) {
      const parsed = parseMuxKey(name);
      expect(parsed).not.toBeNull();
      if (parsed === null) throw new Error(`unparsed: ${name}`);
      expect(formatMuxKey(parsed)).toBe(name);
    }
  });

  // The contract's alphabet is COMPLETE, not the intersection of what today's multiplexers accept.
  // Herdr answers these with `invalid_key` (HERDR_API.md § key grammar) — that is its adapter's
  // `unsupportedKeys` entry, not a hole in the contract, or the first multiplexer that can send Home
  // would have to widen the contract to say so.
  test.each(["PageUp", "PageDown", "Home", "End", "Insert", "Delete"])(
    "%s is contract-valid even where a multiplexer refuses it",
    (name) => {
      expect(isMuxKey(name)).toBe(true);
    },
  );

  // Neither of the other two grammars may be typed into a Collie surface by accident.
  test.each(["C-c", "BTab", "M-Up", "S-Tab"])("tmux spelling %p is not the contract's", (spelling) => {
    expect(isMuxKey(spelling)).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";

import { declareCapabilities, keysDeliverable } from "./capabilities.ts";
import { MUX_CONFORMANCE_FIXTURES } from "./fixtures.ts";
import { toHerdrKey } from "./herdr/keys.ts";
import {
  canonicalMuxKey,
  EXTENDED_ONLY_CHORDS,
  formatMuxKey,
  isExtendedOnlyChord,
  isMuxKey,
  MUX_NAMED_KEYS,
  parseMuxKey,
} from "./keys.ts";
import { toTernKey } from "./tern/keys.ts";
import { toTmuxKey } from "./tmux/keys.ts";
import { toTuiosKey } from "./tuios/keys.ts";
import { toZellijKey } from "./zellij/keys.ts";

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

describe("ctrl+Enter, the chord that needs an extended keyboard encoding", () => {
  test("is matched in any spelling of it, and only it", () => {
    expect(EXTENDED_ONLY_CHORDS).toEqual(["ctrl+Enter"]);
    for (const chord of EXTENDED_ONLY_CHORDS) expect(canonicalMuxKey(chord)).toBe(chord);
    expect(isExtendedOnlyChord("ctrl+Enter")).toBe(true);
    expect(isExtendedOnlyChord("Ctrl+enter")).toBe(true);
    expect(isExtendedOnlyChord("Enter")).toBe(false);
    expect(isExtendedOnlyChord("ctrl+e")).toBe(false);
  });

  // Probed 2026-10-08 against `cat -v` in raw mode: tmux 3.6b and zellij 0.44.2 deliver `^M`, the
  // byte Enter sends. tuios and Tern were not probed, so they refuse it too (fail closed).
  test.each([
    ["tmux", toTmuxKey],
    ["zellij", toZellijKey],
    ["tuios", toTuiosKey],
    ["tern", toTernKey],
  ])("%s refuses it rather than sending a plain Enter", (_mux, translate) => {
    expect(translate("ctrl+Enter")).toEqual({ ok: false, reason: "extended" });
    expect(translate("Enter").ok).toBe(true);
  });

  test("Herdr sends it, as proven on Herdr 0.9.3", () => {
    expect(toHerdrKey("ctrl+Enter").ok).toBe(true);
  });

  test("every adapter that refuses it declares it, so a surface can ask before it offers a button", async () => {
    for (const fixture of MUX_CONFORMANCE_FIXTURES) {
      const world = await fixture.create();
      try {
        const deliverable = keysDeliverable(world.adapter.capabilities, ["ctrl+Enter"]);
        expect(deliverable, `${fixture.mux}${fixture.variant === undefined ? "" : ` (${fixture.variant})`}`).toBe(
          fixture.mux === "herdr",
        );
      } finally {
        await world.close();
      }
    }
  });
});

describe("keysDeliverable", () => {
  const declared = (unsupportedKeys: string[], sendKeys = true) =>
    declareCapabilities({
      supports: sendKeys ? ["sendKeys"] : [],
      unsupportedKeys,
      topologyLatency: { kind: "push" },
    });

  test("a sequence is deliverable only when every key is", () => {
    expect(keysDeliverable(declared([]), ["ctrl+Enter"])).toBe(true);
    expect(keysDeliverable(declared(["ctrl+Enter"]), ["ctrl+Enter"])).toBe(false);
    expect(keysDeliverable(declared(["ctrl+Enter"]), ["Escape", "ctrl+Enter"])).toBe(false);
    expect(keysDeliverable(declared(["ctrl+Enter"]), ["Enter"])).toBe(true);
  });

  test("a refused base key refuses its chords too, as Herdr refuses shift+PageUp", () => {
    expect(keysDeliverable(declared(["PageUp"]), ["shift+PageUp"])).toBe(false);
  });

  test("nothing is deliverable without sendKeys, and a key that is not one never is", () => {
    expect(keysDeliverable(declared([], false), ["Enter"])).toBe(false);
    expect(keysDeliverable(declared([]), ["C-Enter"])).toBe(false);
  });
});

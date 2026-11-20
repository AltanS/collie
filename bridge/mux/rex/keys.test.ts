import { describe, expect, test } from "bun:test";

import { MUX_NAMED_KEYS } from "../keys.ts";
import { toRexKey } from "./keys.ts";

// What each spelling became on a block running `cat -v`, rex 0.0.1795019727 (MUX_CONTRACT.md, RX).

describe("toRexKey", () => {
  test("every named key has a spelling", () => {
    for (const key of MUX_NAMED_KEYS) expect(toRexKey(key).ok).toBe(true);
    expect(toRexKey("PageUp")).toEqual({ ok: true, key: "pageup" });
    expect(toRexKey("F1")).toEqual({ ok: true, key: "f1" });
  });

  test("chords join with +", () => {
    expect(toRexKey("ctrl+c")).toEqual({ ok: true, key: "ctrl+c" });
    expect(toRexKey("shift+Tab")).toEqual({ ok: true, key: "shift+tab" });
    expect(toRexKey("alt+f")).toEqual({ ok: true, key: "alt+f" });
    expect(toRexKey("ctrl+Enter")).toEqual({ ok: true, key: "ctrl+enter" });
  });

  test("a capital is the shifted letter (`A` alone delivered `a`)", () => {
    expect(toRexKey("A")).toEqual({ ok: true, key: "shift+a" });
    expect(toRexKey("ctrl+A")).toEqual({ ok: true, key: "ctrl+a" });
    expect(toRexKey("a")).toEqual({ ok: true, key: "a" });
  });

  test("a space is `space` (a bare blank is an empty binding to rex)", () => {
    expect(toRexKey(" ")).toEqual({ ok: true, key: "space" });
  });

  test("what would arrive as something else is refused", () => {
    // `super+a` delivered nothing at all.
    expect(toRexKey("meta+a")).toEqual({ ok: false, reason: "meta" });
    // `alt+A` and `alt+shift+a` both delivered `^[a`.
    expect(toRexKey("alt+A")).toEqual({ ok: false, reason: "undeliverable" });
    // `ctrl++` delivered nothing.
    expect(toRexKey("ctrl++")).toEqual({ ok: false, reason: "undeliverable" });
    expect(toRexKey("+")).toEqual({ ok: true, key: "+" });
  });

  test("a spelling the contract does not know is unparsed", () => {
    expect(toRexKey("hyper+x")).toEqual({ ok: false, reason: "unparsed" });
  });
});

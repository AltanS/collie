import { describe, expect, test } from "bun:test";

import { MUX_NAMED_KEYS } from "../keys.ts";
import { toTernKey } from "./keys.ts";

describe("toTernKey", () => {
  test("every named key keeps its contract name in lowercase", () => {
    for (const key of MUX_NAMED_KEYS) {
      const res = toTernKey(key);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.key).toBe(key.toLowerCase());
      }
    }
  });

  test("ctrl+c goes on the wire as ctrl+c", () => {
    expect(toTernKey("ctrl+c")).toEqual({ ok: true, key: "ctrl+c" });
  });

  test("shift+Tab goes on the wire as shift+tab", () => {
    expect(toTernKey("shift+Tab")).toEqual({ ok: true, key: "shift+tab" });
  });

  test("ctrl+alt+Delete goes on the wire as ctrl+alt+delete", () => {
    expect(toTernKey("ctrl+alt+Delete")).toEqual({ ok: true, key: "ctrl+alt+delete" });
  });

  test("a literal character passes through", () => {
    expect(toTernKey("a")).toEqual({ ok: true, key: "a" });
    expect(toTernKey("1")).toEqual({ ok: true, key: "1" });
  });

  test("a meta chord is refused", () => {
    expect(toTernKey("meta+c")).toEqual({ ok: false, reason: "meta" });
  });

  test("invalid key is rejected", () => {
    expect(toTernKey("")).toEqual({ ok: false, reason: "unparsed" });
  });
});

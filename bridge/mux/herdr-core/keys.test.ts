import { describe, expect, test } from "bun:test";
import { MUX_NAMED_KEYS } from "../keys.ts";
import { coreKnowsKey } from "./fake-core.ts";
import { toHcKey, type HcKeyRejection } from "./keys.ts";

describe("the contract's keys in herdr-core's spelling", () => {
  test.each([
    ["Enter", "enter"],
    ["Escape", "esc"],
    ["PageUp", "pageup"],
    ["shift+Tab", "shift+tab"],
    ["ctrl+c", "ctrl+c"],
    ["ctrl+alt+Delete", "ctrl+alt+delete"],
    ["alt+,", "alt+,"],
    [" ", "space"],
    ["ctrl+ ", "ctrl+space"],
    ["a", "a"],
    ["/", "/"],
  ])("%s is the key name %s", (spelling, name) => {
    expect(toHcKey(spelling)).toEqual({ ok: true, key: { kind: "key", name } });
  });

  test("every named key of the contract translates to a name the core accepted", () => {
    for (const key of MUX_NAMED_KEYS) {
      const result = toHcKey(key);
      expect(result.ok && result.key.kind === "key" && coreKnowsKey(result.key.name)).toBe(true);
    }
  });

  test.each(["$", "!", "\"", "ä", "_", "~"])("a plain %s the core cannot name is typed as raw input", (char) => {
    expect(toHcKey(char)).toEqual({ ok: true, key: { kind: "text", text: char } });
  });

  test.each<[string, HcKeyRejection]>([
    ["ctrl+$", "unnamed"],
    ["alt+!", "unnamed"],
    ["meta+a", "meta"],
    ["ctrl+Enter", "extended"],
    ["ctrl+", "unparsed"],
    ["Hyper", "unparsed"],
  ])("%s is refused (%s)", (spelling, reason) => {
    expect(toHcKey(spelling)).toEqual({ ok: false, reason });
  });
});

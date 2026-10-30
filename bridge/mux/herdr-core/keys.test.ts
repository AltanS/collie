import { describe, expect, test } from "bun:test";
import { MUX_NAMED_KEYS } from "../keys.ts";
import { coreKnowsKey, FakeHcCore, keyBytes } from "./fake-core.ts";
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
    ["G", "shift+g"],
    ["Z", "shift+z"],
    ["shift+a", "shift+a"],
    ["shift+A", "shift+a"],
    ["alt+G", "alt+shift+g"],
    ["ctrl+g", "ctrl+g"],
    ["ctrl+G", "ctrl+g"],
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

describe("a letter key keeps its case on the core", () => {
  /** Press `spelling` on a fake core and return the bytes the program received. */
  async function received(spelling: string): Promise<number[]> {
    const fake = new FakeHcCore();
    const address = fake.add({});
    const result = toHcKey(spelling);
    if (!result.ok || result.key.kind !== "key") throw new Error(`${spelling} did not translate to a key`);
    await fake.pressKeys(address, [result.key.name]);
    return [...fake.receivedBytes(address)];
  }

  test.each([
    ["G", 0x47],
    ["a", 0x61],
    ["shift+a", 0x41],
    ["ctrl+g", 0x07],
  ])("%s reaches the program as byte 0x%s", async (spelling, byte) => {
    expect(await received(spelling)).toEqual([byte]);
  });

  test("the fake core lower-cases a name, so a mis-cased mapping would fail here", () => {
    expect(keyBytes("G")).toEqual([0x67]);
    expect(keyBytes("shift+g")).toEqual([0x47]);
  });
});

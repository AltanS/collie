import { describe, expect, it } from "vitest";

import type { JsonObject, JsonValue } from "../json";
import { matchRegistryOrigin, sameTheme } from "./registry-match";
import type { Theme } from "./schema";

// A file or a paste that IS a listed theme gets that entry's source; anything less than one exact
// content match gives none.

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";

const THEME: Theme = { version: 1, id: "my-day", name: "My day", author: "Sam", light: { background: "#fdfaf3" }, dark: { background: "#101418" } };

function entry(text: string, over: JsonObject = {}): JsonValue {
  return { repo: "sam/my-day", sha: SHA, path: "collie-theme.json", text, ...over };
}

describe("matchRegistryOrigin", () => {
  it("gives the repo, file and commit of the one entry with the same theme", () => {
    expect(matchRegistryOrigin(THEME, [entry(JSON.stringify(THEME))])).toEqual({
      kind: "registry",
      repo: "sam/my-day",
      path: "collie-theme.json",
      sha: SHA,
    });
  });

  it("matches across white space and key order", () => {
    const shuffled = `{\n  "dark": { "background": "#101418" },\n  "name": "My day",  "id":"my-day",\n "author":"Sam", "version": 1,\n "light": {"background":"#fdfaf3"} }`;
    expect(matchRegistryOrigin(THEME, [entry(shuffled)])?.sha).toBe(SHA);
  });

  it("gives nothing for no match, and for one colour of difference", () => {
    expect(matchRegistryOrigin(THEME, [])).toBeUndefined();
    const off = { ...THEME, dark: { background: "#101419" } };
    expect(matchRegistryOrigin(THEME, [entry(JSON.stringify(off))])).toBeUndefined();
    // The same id and name with other colours is not the same theme.
    expect(matchRegistryOrigin(THEME, [entry(JSON.stringify({ ...THEME, light: { background: "#ffffff" } }))])).toBeUndefined();
  });

  it("gives nothing when two entries hold the same theme: a fork or a copy is never guessed", () => {
    const text = JSON.stringify(THEME);
    expect(matchRegistryOrigin(THEME, [entry(text), entry(text, { repo: "kim/my-day", sha: OTHER_SHA })])).toBeUndefined();
  });

  it("never matches an entry this Collie cannot read, whatever the host's flag says", () => {
    const future = JSON.stringify({ ...THEME, version: 9 });
    expect(matchRegistryOrigin({ ...THEME }, [entry(future, { newer: true })])).toBeUndefined();
    // A readable twin beside it still matches alone.
    expect(matchRegistryOrigin(THEME, [entry(future, { newer: true }), entry(JSON.stringify(THEME))])?.sha).toBe(SHA);
  });

  it("skips an entry that fails its own rules", () => {
    expect(matchRegistryOrigin(THEME, [entry(JSON.stringify(THEME), { repo: "https://evil.example/x" })])).toBeUndefined();
  });
});

describe("sameTheme", () => {
  it("is equality after the parser, key order aside", () => {
    const reordered: Theme = { dark: { background: "#101418" }, light: { background: "#fdfaf3" }, author: "Sam", name: "My day", id: "my-day", version: 1 };
    expect(sameTheme(THEME, reordered)).toBe(true);
    expect(sameTheme(THEME, { ...THEME, name: "My day 2" })).toBe(false);
  });
});

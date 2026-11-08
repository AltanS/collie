import { describe, expect, it } from "vitest";

import type { JsonObject } from "../json";

import { OWNER_PATTERN, PATH_PATTERN, REPO_PATTERN, SHA_PATTERN, isRepoSlug, readNewerEntry, readRegistryEntry } from "./registry";

// F13: one slug and path rule with the site. These sources are the site's own, character for
// character (collie-website, src/lib/theme-registry.ts, pinned by its own test). A change here is a
// change there in the same breath, or an entry one side lists the other refuses.
describe("the registry rules match the site's", () => {
  it("pins the four sources", () => {
    expect(OWNER_PATTERN.source).toBe("^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$");
    expect(REPO_PATTERN.source).toBe("^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\\/(?!\\.\\.?$)[A-Za-z0-9._-]{1,100}$");
    expect(SHA_PATTERN.source).toBe("^[0-9a-f]{40}$");
    expect(PATH_PATTERN.source).toBe(
      "^(?:collie-theme\\.json|themes\\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}\\.collie-theme\\.json)$",
    );
  });

  it("takes an owner as GitHub issues one, and no other", () => {
    for (const ok of ["a", "Sam-1", "x".repeat(39)]) expect(OWNER_PATTERN.test(ok), ok).toBe(true);
    for (const bad of ["", "-sam", "sam_1", ".sam", "sa.m", "x".repeat(40)]) expect(OWNER_PATTERN.test(bad), bad).toBe(false);
  });

  it("takes a repo name with dots and underscores, never . or ..", () => {
    expect(isRepoSlug("sam/.github")).toBe(true);
    expect(isRepoSlug("sam/my_theme.v2")).toBe(true);
    for (const bad of ["sam/.", "sam/..", `sam/${"x".repeat(101)}`]) expect(isRepoSlug(bad), bad).toBe(false);
  });

  it("takes a path at the root or under themes/ with a stem of at most 80", () => {
    expect(PATH_PATTERN.test("collie-theme.json")).toBe(true);
    expect(PATH_PATTERN.test(`themes/${"a".repeat(80)}.collie-theme.json`)).toBe(true);
    for (const bad of [
      `themes/${"a".repeat(81)}.collie-theme.json`,
      "themes/.x.collie-theme.json",
      "themes/a b.collie-theme.json",
      "themes/sub/x.collie-theme.json",
      "x.collie-theme.json",
    ]) {
      expect(PATH_PATTERN.test(bad), bad).toBe(false);
    }
  });
});

describe("a listed theme this Collie cannot read yet", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const at = (file: JsonObject, over: JsonObject = {}): JsonObject => ({
    repo: "sam/my-day",
    sha: SHA,
    path: "collie-theme.json",
    text: JSON.stringify(file),
    ...over,
  });

  it("reads a file whose only refusal is a newer version, with its name and stars", () => {
    const listing = readNewerEntry(at({ version: 9, id: "x", name: "Night", anything: { new: true } }, { stars: 4 }));
    expect(listing).toEqual({ repo: "sam/my-day", sha: SHA, path: "collie-theme.json", version: 9, name: "Night", stars: 4 });
  });

  it("is not a reader of what this Collie reads, nor of a version that is not newer", () => {
    const today = at({ version: 1, id: "x", name: "X", light: { background: "#ffffff" } });
    expect(readRegistryEntry(today)).toBeDefined();
    expect(readNewerEntry(today)).toBeUndefined();
    for (const version of [4, 0, -5, 5.5, "5"]) expect(readNewerEntry(at({ version, id: "x" })), String(version)).toBeUndefined();
  });

  it("refuses the same broken slug, path, sha and size an entry is refused for", () => {
    const file = { version: 9, id: "x" };
    expect(readNewerEntry(at(file, { repo: "https://evil" }))).toBeUndefined();
    expect(readNewerEntry(at(file, { path: "../x.json" }))).toBeUndefined();
    expect(readNewerEntry(at(file, { sha: "abc" }))).toBeUndefined();
    expect(readNewerEntry(at({ ...file, pad: "x".repeat(65 * 1024) }))).toBeUndefined();
    expect(readNewerEntry({ repo: "sam/my-day", sha: SHA, path: "collie-theme.json", text: "not json" })).toBeUndefined();
  });

  it("shows a name only when it is one short line of text", () => {
    expect(readNewerEntry(at({ version: 9, name: "a\nb" }))?.name).toBeUndefined();
    expect(readNewerEntry(at({ version: 9, name: "x".repeat(41) }))?.name).toBeUndefined();
    expect(readNewerEntry(at({ version: 9, name: "  " }))?.name).toBeUndefined();
    expect(readNewerEntry(at({ version: 9, name: 7 }))?.name).toBeUndefined();
  });
});

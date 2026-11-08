import { describe, expect, it } from "vitest";

import { OWNER_PATTERN, PATH_PATTERN, REPO_PATTERN, SHA_PATTERN, isRepoSlug } from "./registry";

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

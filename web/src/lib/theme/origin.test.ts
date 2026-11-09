import { describe, expect, it } from "vitest";

import { fileUrl, readOrigin, shortSha } from "./origin";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const GOOD = { kind: "registry", repo: "sam/my-day", path: "themes/b.collie-theme.json", sha: SHA, at: 1 };

describe("readOrigin", () => {
  it("keeps a registry, a file and a paste origin, and only their named fields", () => {
    expect(readOrigin({ ...GOOD, url: "https://evil.example" })).toEqual(GOOD);
    expect(readOrigin({ kind: "file", at: 2, repo: "sam/x" })).toEqual({ kind: "file", at: 2 });
    expect(readOrigin({ kind: "paste", at: 0 })).toEqual({ kind: "paste", at: 0 });
  });

  it("refuses each part that fails its rule", () => {
    for (const bad of [
      { ...GOOD, repo: "sam/.." },
      { ...GOOD, repo: "https://github.com/sam/x" },
      { ...GOOD, path: "x.json" },
      { ...GOOD, sha: SHA.toUpperCase() },
      { ...GOOD, at: 1.5 },
      { ...GOOD, at: "1" },
      { kind: "file" },
      { kind: "link", at: 1 },
      "registry",
      null,
    ]) {
      expect(readOrigin(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("builds the file link and the short commit from the checked parts", () => {
    expect(fileUrl(GOOD)).toBe(`https://github.com/sam/my-day/blob/${SHA}/themes/b.collie-theme.json`);
    expect(shortSha(SHA)).toBe("0123456");
  });
});

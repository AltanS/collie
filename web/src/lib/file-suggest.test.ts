import { describe, expect, it } from "vitest";

import { segmentsOf } from "./sent-suggest";
import type { FileEntry } from "./types";
import { applyFileSuggestion, findAtToken, resolveAtQuery, suggestFiles } from "./file-suggest";

describe("findAtToken", () => {
  it("matches a bare or typed @ token at the start of the draft or after whitespace", () => {
    expect(findAtToken("@", 1)).toEqual({ start: 0, end: 1, raw: "" });
    expect(findAtToken("@src/ca", 7)).toEqual({ start: 0, end: 7, raw: "src/ca" });
    expect(findAtToken("read @docs/guide.md", 19)).toEqual({ start: 5, end: 19, raw: "docs/guide.md" });
    expect(findAtToken("line1\n@pkg/", 11)).toEqual({ start: 6, end: 11, raw: "pkg/" });
  });

  it("extends end to the full contiguous @ token when the caret sits mid-token", () => {
    expect(findAtToken("check @src/old.ts please", 11)).toEqual({ start: 6, end: 17, raw: "src/" });
  });

  it("ignores emails, non-collapsed selections (null caret), and tokens closed by a trailing space", () => {
    expect(findAtToken("mail user@example.com", 21)).toBeNull();
    expect(findAtToken("foo@bar", 7)).toBeNull();
    expect(findAtToken("@README.md ", 11)).toBeNull();
    expect(findAtToken("@README.md", null)).toBeNull();
    expect(findAtToken("@README.md", -1)).toBeNull();
  });
});

describe("resolveAtQuery", () => {
  it("resolves root-level and nested queries when pane sits at the Files root", () => {
    expect(resolveAtQuery("", "")).toEqual({ apiDir: "", insertPrefix: "", query: "" });
    expect(resolveAtQuery("re", "")).toEqual({ apiDir: "", insertPrefix: "", query: "re" });
    expect(resolveAtQuery("src/", "")).toEqual({ apiDir: "src", insertPrefix: "src/", query: "" });
    expect(resolveAtQuery("src/routes/ch", "")).toEqual({
      apiDir: "src/routes",
      insertPrefix: "src/routes/",
      query: "ch",
    });
    expect(resolveAtQuery("./src/ch", "")).toEqual({
      apiDir: "src",
      insertPrefix: "src/",
      query: "ch",
    });
  });

  it("maps between a subfolder pane cwd and the workspace Files root, including ../ climbs within root", () => {
    expect(resolveAtQuery("", "packages/web")).toEqual({
      apiDir: "packages/web",
      insertPrefix: "",
      query: "",
    });
    expect(resolveAtQuery("src/Ap", "packages/web")).toEqual({
      apiDir: "packages/web/src",
      insertPrefix: "src/",
      query: "Ap",
    });
    expect(resolveAtQuery("../", "packages/web")).toEqual({
      apiDir: "packages",
      insertPrefix: "../",
      query: "",
    });
    expect(resolveAtQuery("../api/no", "packages/web")).toEqual({
      apiDir: "packages/api",
      insertPrefix: "../api/",
      query: "no",
    });
    expect(resolveAtQuery("../../README", "packages/web")).toEqual({
      apiDir: "",
      insertPrefix: "../../",
      query: "README",
    });
  });

  it("refuses paths climbing out of root, absolute @/, double slashes, backslashes, NUL, and .git", () => {
    expect(resolveAtQuery("../", "")).toBeNull();
    expect(resolveAtQuery("../../../x", "packages/web")).toBeNull();
    expect(resolveAtQuery("/etc/passwd", "")).toBeNull();
    expect(resolveAtQuery("src//a", "")).toBeNull();
    expect(resolveAtQuery("src\\a", "")).toBeNull();
    expect(resolveAtQuery("src\0a", "")).toBeNull();
    expect(resolveAtQuery(".git/", "")).toBeNull();
    expect(resolveAtQuery(".GIT/config", "")).toBeNull();
  });
});

describe("suggestFiles", () => {
  const entries: FileEntry[] = [
    { name: "README.md", kind: "file", size: 100 },
    { name: "src", kind: "dir" },
    { name: "docs", kind: "dir" },
    { name: "node_modules", kind: "dir", ignored: true },
    { name: "debug.log", kind: "file", ignored: true },
    { name: "my notes.md", kind: "file" },
    { name: "cart-summary.ts", kind: "file" },
    { name: "cart.ts", kind: "file" },
    { name: "checkout-cart.ts", kind: "file" },
  ];

  it("hides ignored entries and names with whitespace, and orders folders before files on empty query", () => {
    const got = suggestFiles(entries, "", "");
    expect(got.map((s) => s.ariaLabel)).toEqual([
      "@docs/",
      "@src/",
      "@cart-summary.ts",
      "@cart.ts",
      "@checkout-cart.ts",
      "@README.md",
    ]);
    expect(got[0]?.isDir).toBe(true);
    expect(got[2]?.isDir).toBe(false);
    expect(got[0]?.display.marks).toEqual([]);
  });

  it("ranks prefix before substring before fuzzy subsequence, preferring shorter names, and marks matched spans", () => {
    const got = suggestFiles(entries, "src/", "cart");
    expect(got.map((s) => s.ariaLabel)).toEqual([
      "@src/cart.ts",
      "@src/cart-summary.ts",
      "@src/checkout-cart.ts",
    ]);
    expect(segmentsOf(got[0]!.display)).toEqual([
      { text: "@src/", matched: false },
      { text: "cart", matched: true },
      { text: ".ts", matched: false },
    ]);

    const fuzzy = suggestFiles(entries, "", "cts");
    expect(fuzzy.map((s) => s.ariaLabel)).toEqual([
      "@cart.ts",
      "@cart-summary.ts",
      "@checkout-cart.ts",
    ]);
    expect(segmentsOf(fuzzy[0]!.display)).toEqual([
      { text: "@", matched: false },
      { text: "c", matched: true },
      { text: "ar", matched: false },
      { text: "t", matched: true },
      { text: ".t", matched: false },
      { text: "s", matched: true },
    ]);
    const contiguousFuzzy = suggestFiles(entries, "", "ca.ts");
    expect(segmentsOf(contiguousFuzzy[0]!.display)).toEqual([
      { text: "@", matched: false },
      { text: "ca", matched: true },
      { text: "rt", matched: false },
      { text: ".ts", matched: true },
    ]);
  });

  it("compacts deep folder prefixes in chip display so the filename and trailing slash stay visible while ariaLabel keeps the full path", () => {
    const deep = suggestFiles(
      [
        { name: "orders.ts", kind: "file" },
        { name: "handlers", kind: "dir" },
      ],
      "packages/api/server/handlers/",
      "ord",
    );
    expect(deep).toHaveLength(1);
    expect(deep[0]!.ariaLabel).toBe("@packages/api/server/handlers/orders.ts");
    expect(deep[0]!.insert).toBe("@packages/api/server/handlers/orders.ts");
    expect(deep[0]!.display.line.startsWith("@…/")).toBe(true);
    expect(deep[0]!.display.line.endsWith("orders.ts")).toBe(true);
    expect(deep[0]!.display.line.length).toBeLessThanOrEqual(28);
    expect(
      segmentsOf(deep[0]!.display)
        .filter((s) => s.matched)
        .map((s) => s.text)
        .join(""),
    ).toBe("ord");
  });

  it("ranks an exact filename match ahead of prefix-matching folders so 12 folders cannot crowd it out", () => {
    const dirs: FileEntry[] = Array.from({ length: 12 }, (_, i) => ({
      name: `config-${String(i + 1).padStart(2, "0")}`,
      kind: "dir" as const,
    }));
    const got = suggestFiles([...dirs, { name: "config", kind: "file" }], "", "config");
    expect(got).toHaveLength(12);
    expect(got[0]?.ariaLabel).toBe("@config");
    expect(got[0]?.isDir).toBe(false);
  });

  it("never splits a UTF-16 surrogate pair when truncating a long astral filename", () => {
    function hasLoneSurrogate(s: string): boolean {
      for (let i = 0; i < s.length; i += 1) {
        const code = s.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = s.charCodeAt(i + 1);
          if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
          i += 1;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          return true;
        }
      }
      return false;
    }

    for (const tail of [".ts", "a.ts", "ab.tsx"]) {
      const name = `${"😀".repeat(14)}${tail}`;
      const got = suggestFiles([{ name, kind: "file" }], "", "ts");
      expect(got).toHaveLength(1);
      expect(got[0]!.display.line.startsWith("@…")).toBe(true);
      expect(got[0]!.display.line.length).toBeLessThanOrEqual(28);
      expect(hasLoneSurrogate(got[0]!.display.line)).toBe(false);
      expect(
        segmentsOf(got[0]!.display)
          .filter((s) => s.matched)
          .map((s) => s.text)
          .join(""),
      ).toBe("ts");
    }
  });
});

describe("applyFileSuggestion", () => {
  it("appends a trailing space for files without doubling an existing mid-sentence space, and keeps folders open without a space", () => {
    const [dirItem, fileItem] = suggestFiles(
      [
        { name: "src", kind: "dir" },
        { name: "README.md", kind: "file" },
      ],
      "",
      "",
    );

    // At end of draft: file appends space, folder keeps trailing slash with no space.
    expect(applyFileSuggestion("@", { start: 0, end: 1, raw: "" }, dirItem!)).toEqual({
      text: "@src/",
      caret: 5,
    });
    expect(applyFileSuggestion("@re", { start: 0, end: 3, raw: "re" }, fileItem!)).toEqual({
      text: "@README.md ",
      caret: 11,
    });

    // Mid-sentence before an existing space: no double space, caret sits after the space.
    expect(
      applyFileSuggestion("compare @re and @other", { start: 8, end: 11, raw: "re" }, fileItem!),
    ).toEqual({
      text: "compare @README.md and @other",
      caret: 19,
    });

    // Mid-sentence folder tap: preserves following space and leaves caret right after `/`.
    expect(
      applyFileSuggestion("compare @ and @other", { start: 8, end: 9, raw: "" }, dirItem!),
    ).toEqual({
      text: "compare @src/ and @other",
      caret: 13,
    });
  });
});

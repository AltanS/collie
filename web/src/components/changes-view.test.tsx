import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { diffRowKeys, DiffView } from "@/components/changes-view";
import { parseUnifiedDiff } from "@/lib/unified-diff";

const DIFF = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,2 +1,2 @@",
  "-const a = 'x'; // old",
  "+const a = \"y\";",
  " export { a };",
  "",
].join("\n");

describe("DiffView syntax colour", () => {
  it("draws the plain text first, then colours tokens without changing a character", async () => {
    const { container } = render(<DiffView diff={DIFF} path="src/a.ts" />);
    const diff = container.querySelector<HTMLElement>('[data-slot="diff"]')!;
    const before = diff.textContent;
    expect(diff.hasAttribute("data-highlighted")).toBe(false);
    await waitFor(() => expect(diff.hasAttribute("data-highlighted")).toBe(true));
    expect(diff.textContent).toBe(before);
    expect(diff.querySelector(".text-syntax-keyword")?.textContent).toBe("const");
    expect(diff.querySelector(".text-syntax-comment")?.textContent).toBe("// old");
    // A string is several sugar-high tokens (quote, body, quote), merged into one span.
    expect([...diff.querySelectorAll(".text-syntax-string")].map((s) => s.textContent)).toEqual(["'x'", '"y"']);
  });

  it("leaves a file with no known language plain", async () => {
    const { container } = render(<DiffView diff={DIFF} path="LICENSE" />);
    // Give a load, were one started, the chance to land.
    await new Promise((r) => setTimeout(r, 50));
    const diff = container.querySelector<HTMLElement>('[data-slot="diff"]')!;
    expect(diff.hasAttribute("data-highlighted")).toBe(false);
    expect(diff.querySelector('[class*="text-syntax-"]')).toBeNull();
  });

  // The 5 s re-read (ADR 0065 rule 8): a diff that changed under the open view must not flash plain,
  // and the rows it did not change must stay the very same elements.
  it("colours a changed diff in the same render and keeps every unchanged row's element", async () => {
    const { container, rerender } = render(<DiffView diff={DIFF} path="src/a.ts" />);
    const diff = container.querySelector<HTMLElement>('[data-slot="diff"]')!;
    await waitFor(() => expect(diff.hasAttribute("data-highlighted")).toBe(true));
    const rowOf = (text: string) => [...diff.children].find((row) => row.textContent?.includes(text));
    const kept = rowOf("export { a };")!;
    const keptKeyword = kept.querySelector(".text-syntax-keyword");
    expect(keptKeyword?.textContent).toBe("export");

    const grown = DIFF.replace("@@ -1,2 +1,2 @@", "@@ -1,2 +1,3 @@").replace(' export { a };', '+let b = 1;\n export { a };');
    rerender(<DiffView diff={grown} path="src/a.ts" />);
    // No await: the new rows are coloured in the render that drew them.
    expect(diff.hasAttribute("data-highlighted")).toBe(true);
    expect(rowOf("let b = 1;")!.querySelector(".text-syntax-keyword")?.textContent).toBe("let");
    expect(rowOf("export { a };")).toBe(kept);
    expect(kept.querySelector(".text-syntax-keyword")).toBe(keptKeyword);
  });
});

describe("diffRowKeys", () => {
  it("keys a row by its content, so a line added above moves no other row's key", () => {
    const before = diffRowKeys(parseUnifiedDiff(DIFF).rows);
    const after = diffRowKeys(parseUnifiedDiff(DIFF.replace("+const a", "+// new\n+const a")).rows);
    expect(after.length).toBe(before.length + 1);
    for (const key of before) expect(after).toContain(key);
  });

  it("tells the same line apart by its place among its repeats", () => {
    const twice = "@@ -1,2 +1,2 @@\n x\n x\n";
    const keys = diffRowKeys(parseUnifiedDiff(twice).rows);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

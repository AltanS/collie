import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ChangePath, ChangesList, diffRowKeys, DiffView, StatusLetter } from "@/components/changes-view";
import type { ChangedRepo } from "@/lib/types";
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

describe("a long file name keeps both ends", () => {
  // The bug this pins: the tree truncated a name from the LEFT, which is right for a path and wrong
  // for a basename. A memory folder rendered every row as `…m_breaks_under_podman_compose.md`, with
  // the ordinal prefix that ORDERS them cut off each time.
  const LONG = "0007_docker_daemon_breaks_under_podman_compose.md";

  it("splits a long name so the head and the tail both survive", () => {
    const { container } = render(<ChangePath path={`notes/${LONG}`} />);
    const spans = [...container.querySelectorAll("span")].map((el) => el.textContent ?? "");

    // Two halves, and they rejoin to the whole name: nothing is dropped from the DOM, the middle is
    // only hidden by the head's own overflow.
    const head = spans.find((t) => t !== "" && LONG.startsWith(t) && t !== LONG);
    const tail = spans.find((t) => t !== "" && LONG.endsWith(t) && t !== LONG);
    expect(head).toBeTruthy();
    expect(tail).toBeTruthy();
    expect(`${head ?? ""}${tail ?? ""}`).toBe(LONG);

    // The two things a reader needs: the ordinal that orders the row, and the extension.
    expect(head?.startsWith("0007_")).toBe(true);
    expect(tail?.endsWith(".md")).toBe(true);
  });

  it("only the head may be clipped, and the tail never shrinks", () => {
    const { container } = render(<ChangePath path={`notes/${LONG}`} />);
    const head = [...container.querySelectorAll("span")].find(
      (el) => (el.textContent ?? "") !== "" && LONG.startsWith(el.textContent ?? "") && el.textContent !== LONG,
    );
    expect(head?.className).toContain("truncate");
    expect(head?.nextElementSibling?.className).toContain("shrink-0");
  });

  it("leaves a short name in one piece, with no split to read around", () => {
    const { container } = render(<ChangePath path="src/a.ts" />);
    const exact = [...container.querySelectorAll("span")].filter((el) => el.textContent === "a.ts");
    expect(exact).toHaveLength(1);
  });
});

describe("untracked is one colour on the Changes screen", () => {
  const repos: ChangedRepo[] = [
    {
      relPath: ".",
      name: "webapp",
      files: [
        { path: "notes.md", status: "?", added: 0, removed: 0, binary: false },
        { path: "src/a.ts", status: "A", added: 1, removed: 0, binary: false },
      ],
    },
  ];

  it("a list row's U wears the added ink, the same as an A", () => {
    const { container } = render(<ChangesList repos={repos} onOpen={() => {}} />);
    const letters = [...container.querySelectorAll("span[aria-hidden]")].filter((el) => el.textContent === "U" || el.textContent === "A");
    const u = letters.find((el) => el.textContent === "U")!;
    expect(u.className).toContain("text-status-done");
    expect(u.className).not.toContain("text-muted-foreground");
    expect(letters.find((el) => el.textContent === "A")!.className).toContain("text-status-done");
  });

  it("the letter the file header draws is the same ink", () => {
    const { container } = render(<StatusLetter status="?" />);
    expect(container.querySelector("span[aria-hidden]")!.className).toContain("text-status-done");
  });
});

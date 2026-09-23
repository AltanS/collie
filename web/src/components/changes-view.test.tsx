import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DiffView } from "@/components/changes-view";

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
});

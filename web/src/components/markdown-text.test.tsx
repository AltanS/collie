import { fireEvent, render, screen } from "@testing-library/react";

import { testFileOpener } from "@/test/file-links";

import { FileLinksProvider } from "./file-links";
import { MarkdownText } from "./markdown-text";

// The renderer's one LAYOUT decision, which is here because no CSS property can make it.
//
// A hyphen, a slash and a colon are ordinary wrap opportunities, so `--force` broke as `--` /
// `force` whenever it landed near the right edge. `white-space: nowrap` is the only thing that
// forbids that, and it also forbids the break a 78 character path genuinely needs. So the renderer
// looks at the text: short enough to fit a column of its own, never break; longer, break anywhere.
// The 24 character line and the measurements behind it are in the component.

const chipOf = (text: string) => screen.getByText(text, { selector: "code" });

describe("MarkdownText line breaking", () => {
  it("a short chip is never broken", () => {
    render(<MarkdownText text="re-run it with `--force` and read the results" />);
    expect(chipOf("--force").className).toContain("whitespace-nowrap");
  });

  it("a branch full of hyphens is still one piece", () => {
    render(<MarkdownText text="on branch `readme-herdr-client` in a worktree" />);
    expect(chipOf("readme-herdr-client").className).toContain("whitespace-nowrap");
  });

  it("a chip too long for a narrow column may break anywhere", () => {
    const long = "/var/home/altan/projects/collie/web/src/components/markdown-text.tsx";
    render(<MarkdownText text={`open \`${long}\` now`} />);
    expect(chipOf(long).className).toContain("wrap-anywhere");
  });

  it("a short link is not split across lines either", () => {
    render(<MarkdownText text="Chat is live on http://bluefin:8788 for you" />);
    expect(screen.getByRole("link").className).toContain("whitespace-nowrap");
  });

  it("a long link may break anywhere", () => {
    const url = "https://github.com/AltanS/collie/blob/main/web/src/components/markdown-text.tsx";
    render(<MarkdownText text={`see ${url} for it`} />);
    expect(screen.getByRole("link").className).toContain("wrap-anywhere");
  });
});

// JetBrains Mono, first in `--font-mono`, draws `>=`, `<=` and `!==` as one glyph. Code the reader
// compares character by character must not take them. The source view, the diffs and the terminal
// already set the property; the renderer's two code surfaces did not, which put the ligatures into Chat.
describe("MarkdownText code draws no ligatures", () => {
  it("inline code and a fenced block both turn them off", () => {
    const { container } = render(<MarkdownText text={"a `x >= y` chip\n\n```\nif (a !== b) {}\n```"} />);
    expect(chipOf("x >= y").className).toContain("[font-variant-ligatures:none]");
    expect(container.querySelector("pre")?.className).toContain("[font-variant-ligatures:none]");
  });
});

describe("MarkdownText headings", () => {
  const md = "# One\n\n## Two\n\n### Three\n\n#### Four\n\nbody";
  const level = (container: HTMLElement, n: number) => container.querySelector(`[data-heading-level="${n}"]`);

  it("Chat keeps its small headings and gains no document hooks", () => {
    const { container } = render(<MarkdownText text={md} />);
    expect(screen.getByText("One").className).toContain("text-base font-semibold");
    expect(screen.getByText("Two").className).toContain("text-[0.95rem]");
    expect(container.querySelector("[data-heading-level]")).toBeNull();
  });

  it("a document steps down in size, with more space above a heading than below", () => {
    const { container } = render(<MarkdownText text={md} variant="document" />);
    const size = (n: number) => /\btext-(2xl|xl|base|sm)\b/.exec(level(container, n)?.className ?? "")?.[1];
    expect([1, 2, 3, 4].map(size)).toEqual(["2xl", "xl", "base", "sm"]);
    for (const n of [1, 2, 3, 4]) {
      const cls = level(container, n)?.className ?? "";
      const above = Number(/\bmt-(\d+)\b/.exec(cls)?.[1]);
      const below = Number(/\bmb-(\d+(?:\.\d+)?)\b/.exec(cls)?.[1]);
      expect(above).toBeGreaterThan(below);
    }
  });
});

// ── Paths the agent printed (ADR 0088) ─────────────────────────────────────────────────────────

describe("MarkdownText file paths", () => {
  const withLinks = (text: string, opened: string[] = []) =>
    render(
      <FileLinksProvider value={testFileOpener(opened)}>
        <MarkdownText text={text} />
      </FileLinksProvider>,
    );

  it("a code span that is a path opens Files at its line", () => {
    const opened: string[] = [];
    const { container } = withLinks("see `src/cart.ts:12` for it", opened);
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/pane/w1%3Ap1/changes/files?path=src%2Fcart.ts&line=12");
    expect(link.querySelector("code")?.textContent).toBe("src/cart.ts:12");
    fireEvent.click(link);
    expect(opened).toEqual(["/pane/w1%3Ap1/changes/files?path=src%2Fcart.ts&line=12"]);
  });

  it("a path in plain prose becomes the same chip, and the prose around it stays", () => {
    const { container } = withLinks("I saved it to docs/guide.md and stopped.");
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/pane/w1%3Ap1/changes/files?path=docs%2Fguide.md");
    expect(container.textContent).toBe("I saved it to docs/guide.md and stopped.");
  });

  it("a path outside the root, a code name and a bare word stay text", () => {
    const { container } = withLinks("read /etc/hosts, call `process.env` and `items.map`, and/or not");
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelectorAll("code")).toHaveLength(2);
  });

  it("with no opener (History, a Files preview) nothing is a link", () => {
    const { container } = render(<MarkdownText text="see `src/cart.ts` and docs/guide.md" />);
    expect(container.querySelector("a")).toBeNull();
  });

  it("never nests a path inside a link's label", () => {
    const { container } = withLinks("[docs/guide.md](https://example.com/guide)");
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelector("a")!.getAttribute("href")).toBe("https://example.com/guide");
  });
});

import { render, screen } from "@testing-library/react";

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

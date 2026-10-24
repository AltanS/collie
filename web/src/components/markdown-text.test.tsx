import { fireEvent, render, screen } from "@testing-library/react";

import { testFileOpener } from "@/test/file-links";

import { FileLinksProvider } from "./file-links";
import { MarkdownText, StretchTextContext } from "./markdown-text";

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

// ── Web addresses inside backticks ─────────────────────────────────────────────────────────────
// Claude Code prints most addresses as code spans (`http://bluefin:8788`), which the parser keeps
// verbatim, so they were dead text until the code span itself looked for an address.

describe("MarkdownText web addresses in code spans", () => {
  it("a code span that is an address is one link in a new tab, and keeps the chip", () => {
    const { container } = render(<MarkdownText text="open `http://bluefin:8788` now" />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("http://bluefin:8788");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.querySelector("code")?.textContent).toBe("http://bluefin:8788");
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.textContent).toBe("open http://bluefin:8788 now");
  });

  it("an address in a span with a trailing full stop links without it", () => {
    const { container } = render(<MarkdownText text="at `http://x/.`" />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("http://x/");
    expect(link.textContent).toBe("http://x/");
    expect(container.querySelector("code")?.textContent).toBe("http://x/.");
  });

  it("an address inside a longer span links only its own token", () => {
    const { container } = render(<MarkdownText text="run `curl -s https://example.com/health | jq` first" />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("https://example.com/health");
    expect(link.textContent).toBe("https://example.com/health");
    expect(container.querySelector("code")?.textContent).toBe("curl -s https://example.com/health | jq");
    expect(container.querySelectorAll("a")).toHaveLength(1);
  });

  it("a mailto address links, and two addresses in one span are two links", () => {
    render(<MarkdownText text="`mailto:a@b.dev` and `http://a:1 http://b:2`" />);
    expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["mailto:a@b.dev", "http://a:1", "http://b:2"]);
  });

  it("a plain word, a command and a javascript: address in a span are not links", () => {
    const { container } = render(<MarkdownText text="`bluefin` `bun run test` `javascript:alert(1)` `www.example.com`" />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelectorAll("code")).toHaveLength(4);
  });

  it("a path in a code span is still a file link, and an address beside it is a web link", () => {
    const opened: string[] = [];
    const { container } = render(
      <FileLinksProvider value={testFileOpener(opened)}>
        <MarkdownText text="see `src/cart.ts:12` and `http://bluefin:8788`" />
      </FileLinksProvider>,
    );
    const links = [...container.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/pane/w1%3Ap1/changes/files?path=src%2Fcart.ts&line=12",
      "http://bluefin:8788",
    ]);
    fireEvent.click(links[0]!);
    expect(opened).toHaveLength(1);
  });

  it("never nests an address inside a link's label", () => {
    const { container } = render(<MarkdownText text="[`http://a:1`](https://example.com/x)" />);
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelector("a")!.getAttribute("href")).toBe("https://example.com/x");
  });
});

// Stretchtext (`{{short|long}}`, the cc-stretch plugin's markup) is drawn only where both the screen
// says this device draws it and the text is agent reply prose; anywhere else the markup reads as written.
function withStretches(text: string, { query = "", stretches = true, on = true } = {}) {
  return render(
    <StretchTextContext.Provider value={on}>
      <MarkdownText text={text} query={query} stretches={stretches} />
    </StretchTextContext.Provider>,
  );
}

describe("stretches", () => {
  it("shows the short form, opens to the long form, and closes back", () => {
    withStretches("see {{the cache|the cache keeps one entry per key}} now");
    expect(screen.queryByText(/one entry per key/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "the cache" }));
    expect(screen.getByText(/one entry per key/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "the cache" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.getByRole("button", { name: "the cache" })).toBeInTheDocument();
    expect(screen.queryByText(/one entry per key/)).toBeNull();
  });

  it("closing a stretch closes the ones opened inside it", () => {
    withStretches("a {{parent|outer {{child|inner words}} end}} b");
    fireEvent.click(screen.getByRole("button", { name: "parent" }));
    fireEvent.click(screen.getByRole("button", { name: "child" }));
    expect(screen.getByText(/inner words/)).toBeInTheDocument();

    // The parent's closer comes after its whole long form, so it is the last one.
    const closers = screen.getAllByRole("button", { name: "Show less" });
    fireEvent.click(closers[closers.length - 1]!);
    fireEvent.click(screen.getByRole("button", { name: "parent" }));
    expect(screen.getByRole("button", { name: "child" })).toBeInTheDocument();
    expect(screen.queryByText(/inner words/)).toBeNull();
  });

  it("opens from the keyboard", () => {
    withStretches("x {{short|the long form}} y");
    fireEvent.keyDown(screen.getByRole("button", { name: "short" }), { key: "Enter" });
    expect(screen.getByText(/the long form/)).toBeInTheDocument();
  });

  it("leaves a stretch inside a code span as written", () => {
    withStretches("run `{{a|b}}` here");
    expect(screen.getByText("{{a|b}}", { selector: "code" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a find opens every stretch, so a hit inside a long form is marked", () => {
    const { container } = withStretches("x {{short|a needle inside}} y", { query: "needle" });
    expect(screen.queryByRole("button", { name: "short" })).toBeNull();
    expect(container.querySelector("mark")?.textContent).toBe("needle");
  });

  it("reads the markup as written when this device does not draw stretches", () => {
    withStretches("see {{a|b}} now", { on: false });
    expect(screen.getByText("see {{a|b}} now")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("reads the markup as written in text that is not agent reply prose", () => {
    withStretches("see {{a|b}} now", { stretches: false });
    expect(screen.getByText("see {{a|b}} now")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("underlines each closed stretch in its own hue", () => {
    withStretches("{{one|first words}} and {{two|second words}}");
    expect(screen.getByRole("button", { name: "one" })).toHaveClass("decoration-stretch-1");
    expect(screen.getByRole("button", { name: "two" })).toHaveClass("decoration-stretch-2");
  });

  it("draws the words an open stretch added in its hue, and its anchors in the text's ink", () => {
    withStretches("x {{monad|a monad is a type}} y");
    fireEvent.click(screen.getByRole("button", { name: "monad" }));
    expect(screen.getByText("is a type")).toHaveClass("text-stretch-1");
    expect(screen.getByText(/monad/).closest("[class*='text-stretch']")).toBeNull();
    expect(screen.getByRole("button", { name: "Show less" })).toHaveClass("text-stretch-1");
  });

  it("fades an open stretch's words once another is opened after it", () => {
    withStretches("{{one|first words}} and {{two|second words}}");
    fireEvent.click(screen.getByRole("button", { name: "one" }));
    expect(screen.getByText("first words")).toHaveClass("text-stretch-1");

    fireEvent.click(screen.getByRole("button", { name: "two" }));
    expect(screen.getByText("first words")).toHaveClass("text-stretch-1-faded");
    expect(screen.getByText("second words")).toHaveClass("text-stretch-2");
    // A closer keeps its stretch's unfaded colour.
    const [first, second] = screen.getAllByRole("button", { name: "Show less" });
    expect(first).toHaveClass("text-stretch-1");
    expect(second).toHaveClass("text-stretch-2");
  });

  it("a stretch in bold, in a list item and in a table cell is a button", () => {
    withStretches("**see {{bold one|b}}**\n\n- item {{list one|c}}\n\n| h | k |\n| --- | --- |\n| {{cell one|d}} | z |");
    for (const name of ["bold one", "list one", "cell one"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });
});

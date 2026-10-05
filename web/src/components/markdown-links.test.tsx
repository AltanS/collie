import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MarkdownText, type LinkResolver } from "./markdown-text";

afterEach(cleanup);

// What a link looks like once the parser has said what it is. The transcript has no resolver, so a
// link that is not a web address reads as its label; a screen that knows what a path is relative to
// (the Files preview) supplies one. See `file-preview.test.tsx` for that screen.

describe("a link in the transcript, with no resolver", () => {
  it("an external link opens in a new tab, as it always did", () => {
    render(<MarkdownText text="see [the docs](https://example.com/a) now" />);
    const a = screen.getByRole("link", { name: "the docs" });
    expect(a.getAttribute("href")).toBe("https://example.com/a");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it.each([
    ["a relative path", "[the guide](./guide.md)"],
    ["a bare path", "[the guide](docs/guide.md)"],
    ["a parent path", "[the guide](../guide.md)"],
    ["a rooted path", "[the guide](/guide.md)"],
    ["a fragment", "[the guide](#guide)"],
    ["a reference", "[the guide][g]\n\n[g]: ./guide.md"],
  ])("%s reads as its label, never as a dead anchor or as raw Markdown", (_label, source) => {
    const { container } = render(<MarkdownText text={source} />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("the guide");
  });

  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,x"],
    ["file:", "file:///etc/passwd"],
    ["vbscript:", "vbscript:x"],
    ["a protocol-relative host", "//evil.example/x"],
  ])("%s shows the label only", (_label, href) => {
    const { container } = render(<MarkdownText text={`[click me](${href})`} />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("click me");
  });

  it("an autolink shows no angle brackets", () => {
    const { container } = render(<MarkdownText text="open <https://example.com/x> now" />);
    expect(screen.getByRole("link").textContent).toBe("https://example.com/x");
    expect(container.textContent).toBe("open https://example.com/x now");
  });

  it("an image reads as its alt text and loads nothing", () => {
    const { container } = render(<MarkdownText text="a ![the logo](https://example.com/logo.png) b" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("a the logo b");
  });

  it("a badge is one link, labelled with its alt text", () => {
    const { container } = render(<MarkdownText text="[![Build](https://ci.example/b.svg)](https://ci.example/run)" />);
    expect(container.querySelector("img")).toBeNull();
    const a = screen.getByRole("link", { name: "Build" });
    expect(a.getAttribute("href")).toBe("https://ci.example/run");
  });

  it("a title is not shown, and a URL with parentheses keeps them", () => {
    const { container } = render(<MarkdownText text={'[wiki](https://en.wikipedia.org/wiki/Foo_(bar) "The title") end'} />);
    expect(screen.getByRole("link", { name: "wiki" }).getAttribute("href")).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
    expect(container.textContent).toBe("wiki end");
  });

  it("a reference link to the web links, and its definition is not drawn", () => {
    const { container } = render(<MarkdownText text={"see [docs][d] and [docs]\n\n[d]: https://example.com/docs\n[docs]: https://example.com/other"} />);
    expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["https://example.com/docs", "https://example.com/other"]);
    expect(container.textContent).toBe("see docs and docs");
  });

  it("headings carry no id, so the transcript never collides with the app's own", () => {
    const { container } = render(<MarkdownText text="# Root" />);
    expect(container.querySelector("[id]")).toBeNull();
  });
});

describe("a link with a resolver", () => {
  const local = (onOpen = vi.fn()): LinkResolver => (href) => ({ kind: "local", href: `/app?to=${href}`, onOpen });

  it("a relative link becomes an anchor in the app: no new tab, and the tap is the screen's", () => {
    const onOpen = vi.fn();
    render(<MarkdownText text="[the guide](./guide.md)" resolveLink={local(onOpen)} />);
    const a = screen.getByRole("link", { name: "the guide" });
    expect(a.getAttribute("href")).toBe("/app?to=./guide.md");
    expect(a.getAttribute("target")).toBeNull();
    // `fireEvent.click` returns false when the default was prevented, so the browser did not follow.
    expect(fireEvent.click(a)).toBe(false);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("a modified click is left to the browser", () => {
    const onOpen = vi.fn();
    render(<MarkdownText text="[the guide](./guide.md)" resolveLink={local(onOpen)} />);
    // The document sees the click after the component did. jsdom would try to navigate, so it ends
    // the click there, after noting whether the component had already claimed it.
    const claimed: boolean[] = [];
    const seen = (e: Event) => {
      claimed.push(e.defaultPrevented);
      e.preventDefault();
    };
    document.addEventListener("click", seen);
    fireEvent.click(screen.getByRole("link"), { ctrlKey: true });
    fireEvent.click(screen.getByRole("link"), { metaKey: true });
    document.removeEventListener("click", seen);
    expect(claimed).toEqual([false, false]);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("a `text` answer reads as the label", () => {
    const { container } = render(<MarkdownText text="[out](../../x.md)" resolveLink={() => ({ kind: "text" })} />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("out");
  });

  it("is asked about relative and fragment links, never about a web address or a refused one", () => {
    const resolve = vi.fn<LinkResolver>(() => ({ kind: "text" }));
    render(<MarkdownText text="[a](https://x.example) [b](javascript:alert(1)) [c](./c.md) [d](#d)" resolveLink={resolve} />);
    expect(resolve.mock.calls.map(([href]) => href)).toEqual(["./c.md", "#d"]);
  });

  it("a reference link to a relative path reaches the resolver too", () => {
    const resolve = vi.fn<LinkResolver>(() => ({ kind: "text" }));
    render(<MarkdownText text={"[a][g]\n\n[g]: ./guide.md"} resolveLink={resolve} />);
    expect(resolve).toHaveBeenCalledWith("./guide.md");
  });

  it("a badge that links to a relative file is a link labelled with the alt text", () => {
    render(<MarkdownText text="[![Tests](badge.svg)](./CI.md)" resolveLink={local()} />);
    expect(screen.getByRole("link", { name: "Tests" }).getAttribute("href")).toBe("/app?to=./CI.md");
  });
});

describe("heading ids", () => {
  it("each heading gets its anchor, a repeat gets -1, and a heading with no letters gets none", () => {
    const { container } = render(<MarkdownText text={"# Getting Started\n\n## Usage\n\n## Usage\n\n## ???\n\ntext"} headingIds />);
    expect([...container.querySelectorAll("[id]")].map((el) => el.id)).toEqual(["getting-started", "usage", "usage-1"]);
  });
});

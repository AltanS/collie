import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { en } from "@/lib/i18n/messages/en";
import type { FilesAt } from "@/lib/nav";
import { fixtureFileRead } from "@/test/handlers";

import { defaultView, FileContent, type FileLinks, type FileText } from "./file-preview";

afterEach(cleanup);

function file(path: string, over: Partial<FileText> = {}): FileText {
  const read = fixtureFileRead(path);
  if (read === null || !read.available) throw new Error(`no fixture for ${path}`);
  return { ...read, ...over };
}

describe("defaultView", () => {
  it("opens Preview for a type that has one, and Source for the rest", () => {
    expect(defaultView("README.md")).toBe("preview");
    expect(defaultView("a/b.JSON")).toBe("preview");
    expect(defaultView("page.htm")).toBe("preview");
    expect(defaultView("src/cart.ts")).toBe("source");
    expect(defaultView("Makefile")).toBe("source");
  });
});

describe("Source", () => {
  it("numbers the lines and drops the newline that ends the last one", () => {
    const { container } = render(<FileContent file={file("src/cart.ts")} view="source" />);
    const rows = container.querySelectorAll("[data-slot='file-source'] > div");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain("1");
    expect(rows[2]?.textContent).toContain("3");
    expect(container.textContent).toContain("cartTotal");
  });

  it("marks the line a printed path named and brings it into view once (ADR 0088)", () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    scroll.mockClear();
    const { container } = render(<FileContent file={file("src/cart.ts")} view="source" line={2} />);
    const rows = [...container.querySelectorAll("[data-slot='file-source'] > div")];
    expect(rows.map((r) => r.getAttribute("aria-current"))).toEqual([null, "location", null]);
    expect(rows[1]!.className).toContain("bg-accent");
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(rows[1]);
    scroll.mockRestore();
  });

  it("a line past the end marks nothing and scrolls nowhere", () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    scroll.mockClear();
    const { container } = render(<FileContent file={file("src/cart.ts")} view="source" line={99} />);
    expect(container.querySelector("[aria-current]")).toBeNull();
    expect(scroll).not.toHaveBeenCalled();
    scroll.mockRestore();
  });

  it("says so after the text when the read was cut", () => {
    render(<FileContent file={file("src/cart.ts", { truncated: true })} view="source" />);
    expect(screen.getByText(en["files.fileTruncated"])).toBeTruthy();
  });

  it("shows an empty file as a sentence", () => {
    render(<FileContent file={file("src/cart.ts", { text: "", size: 0 })} view="source" />);
    expect(screen.getByText(en["files.fileEmpty"])).toBeTruthy();
  });

  it("shows source for a file with a preview when Source is asked for", () => {
    const { container } = render(<FileContent file={file("README.md")} view="source" />);
    expect(container.querySelector("[data-slot='file-source']")).toBeTruthy();
    expect(container.querySelector("[data-slot='file-markdown']")).toBeNull();
  });
});

describe("Source: the 5000-line cap", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

  it("renders 5000 lines in full, with no note", () => {
    const { container } = render(<FileContent file={file("src/cart.ts", { text: lines(5000) })} view="source" />);
    expect(container.querySelectorAll("[data-slot='file-source'] > div")).toHaveLength(5000);
    expect(screen.queryByText(en["files.linesCapped"])).toBeNull();
  });

  it("renders the first 5000 lines of a longer file and one plain line after them", () => {
    const { container } = render(<FileContent file={file("src/cart.ts", { text: lines(5001) })} view="source" />);
    expect(container.querySelectorAll("[data-slot='file-source'] > div")).toHaveLength(5000);
    expect(container.textContent).toContain("line 5000");
    expect(container.textContent).not.toContain("line 5001");
    expect(screen.getByText(en["files.linesCapped"])).toBeTruthy();
  });
});

describe("a binary file", () => {
  it("shows its size and nothing else", () => {
    const { container } = render(<FileContent file={file("logo.png")} view="source" />);
    expect(screen.getByText("Binary file, 20 KB")).toBeTruthy();
    expect(container.querySelector("[data-slot='file-source']")).toBeNull();
  });
});

describe("Preview: Markdown", () => {
  it("renders structure, and keeps raw HTML as text", () => {
    const { container } = render(<FileContent file={file("README.md")} view="preview" />);
    expect(screen.getByText("Webapp")).toBeTruthy();
    expect(screen.getByText("Run it").tagName).toBe("STRONG");
    expect(screen.getByRole("link", { name: "docs" }).getAttribute("href")).toBe("https://example.com/docs");
    // The <script> line is characters in a paragraph, never an element.
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });
});

describe("Preview: Markdown past 5000 lines", () => {
  const long = (n: number) => Array.from({ length: n }, (_, i) => `row ${i + 1}`).join("\n");

  it("falls back to the source, and the note says the source is cut", () => {
    const { container } = render(<FileContent file={file("README.md", { text: long(5001) })} view="preview" />);
    expect(container.querySelector("[data-slot='file-markdown']")).toBeNull();
    expect(container.querySelectorAll("[data-slot='file-source'] > div")).toHaveLength(5000);
    expect(screen.getByText(en["files.linesCapped"])).toBeTruthy();
  });

  it("still renders a Markdown file of exactly 5000 lines as a page", () => {
    const { container } = render(<FileContent file={file("README.md", { text: long(5000) })} view="preview" />);
    expect(container.querySelector("[data-slot='file-markdown']")).toBeTruthy();
  });
});

describe("Preview: JSON", () => {
  it("draws a tree with the first two levels open and the rest folded, with a count", async () => {
    render(<FileContent file={file("package.json")} view="preview" />);
    // Level 0 (the object) and level 1 (its keys) are open: `scripts` shows its count and is folded
    // one level further down only when it has containers inside.
    expect(screen.getByText("name")).toBeTruthy();
    expect(screen.getByText('"webapp"')).toBeTruthy();
    const scripts = screen.getByRole("button", { name: /scripts/ });
    expect(scripts.getAttribute("aria-expanded")).toBe("true");
    expect(within(scripts).getByText("2 keys")).toBeTruthy();
    await userEvent.click(scripts);
    expect(scripts.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText('"vite"')).toBeNull();
    // The count stays on the row folded or open.
    expect(within(scripts).getByText("2 keys")).toBeTruthy();
  });

  it("folds a container at the third level and shows its count", () => {
    const text = JSON.stringify({ a: { b: { c: 1, d: 2, e: [1, 2, 3] } } });
    render(<FileContent file={file("package.json", { text })} view="preview" />);
    const b = screen.getByRole("button", { name: /^b/ });
    expect(b.getAttribute("aria-expanded")).toBe("false");
    expect(within(b).getByText("3 keys")).toBeTruthy();
    expect(screen.queryByText("c")).toBeNull();
  });

  it("says why on a parse error and shows the source", () => {
    const { container } = render(<FileContent file={file("package.json", { text: '{"a": ' })} view="preview" />);
    expect(screen.getByRole("status").textContent).toMatch(/^Not valid JSON: /);
    expect(container.querySelector("[data-slot='file-source']")).toBeTruthy();
    expect(container.querySelector("[data-slot='file-json']")).toBeNull();
  });

  it("falls back to the source above 5000 values", () => {
    const text = JSON.stringify(Array.from({ length: 5001 }, (_, i) => i));
    const { container } = render(<FileContent file={file("package.json", { text })} view="preview" />);
    expect(screen.getByText(en["files.json.tooBig"])).toBeTruthy();
    expect(container.querySelector("[data-slot='file-source']")).toBeTruthy();
  });

  it("draws exactly 5000 values as a tree", () => {
    const text = JSON.stringify(Array.from({ length: 4999 }, (_, i) => i));
    const { container } = render(<FileContent file={file("package.json", { text })} view="preview" />);
    expect(container.querySelector("[data-slot='file-json']")).toBeTruthy();
  });

  it("puts every string in as text, never as markup", () => {
    const text = JSON.stringify({ evil: "<img src=x onerror=alert(1)>" });
    const { container } = render(<FileContent file={file("package.json", { text })} view="preview" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("Preview: HTML", () => {
  it("is a frame with an EMPTY sandbox, the file as srcdoc, and the caption", () => {
    const { container } = render(<FileContent file={file("index.html")} view="preview" />);
    const frame = container.querySelector("iframe");
    expect(frame).toBeTruthy();
    // Present and empty: every capability off. A missing attribute would be a full-power frame.
    expect(frame?.hasAttribute("sandbox")).toBe(true);
    expect(frame?.getAttribute("sandbox")).toBe("");
    expect(frame?.getAttribute("srcdoc")).toContain("Hello from a file");
    expect(frame?.getAttribute("src")).toBeNull();
    expect(screen.getByText(en["files.html.caption"])).toBeTruthy();
  });

  it("never puts the file's markup into the app's DOM", () => {
    const text = '<h1 id="mine">Hi</h1><script>window.pwned = 1</script>';
    const { container } = render(<FileContent file={file("index.html", { text })} view="preview" />);
    expect(container.querySelector("#mine")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect("pwned" in window).toBe(false);
  });
});

// A link in a Markdown file is read where the file lives: relative to its folder, with `/x` from the
// Files root, and a `#fragment` scrolling in place.
describe("Preview: Markdown links", () => {
  const FROM = "docs/guide.md";
  const md = (text: string) => file("README.md", { path: FROM, text });
  const open = vi.fn<(at: FilesAt) => void>();
  const links: FileLinks = {
    hrefFor: (at) => `/files?${at.path !== undefined ? `path=${at.path}` : `dir=${at.dir ?? ""}`}`,
    onOpen: open,
  };
  const show = (text: string, over: { links?: FileLinks } = { links }) =>
    render(<FileContent file={md(text)} view="preview" links={over.links} />);
  beforeEach(() => open.mockClear());

  it.each([
    ["a sibling", "./other.md", { path: "docs/other.md" }],
    ["a parent's file", "../README.md", { path: "README.md" }],
    ["a root-absolute path, from the Files root", "/src/cart.ts", { path: "src/cart.ts" }],
    ["an encoded space", "my%20notes.md", { path: "docs/my notes.md" }],
    ["a fragment on a file", "other.md#install", { path: "docs/other.md" }],
    ["a folder", "../src/", { dir: "src" }],
    ["the root", "../", { dir: "" }],
  ])("%s opens in Files, one level down", (_label, href, expected) => {
    show(`[go](${href})`);
    const a = screen.getByRole("link", { name: "go" });
    expect(a.getAttribute("target")).toBeNull();
    expect(a.getAttribute("href")).toBe(links.hrefFor(expected));
    fireEvent.click(a);
    expect(open).toHaveBeenCalledWith(expected);
  });

  it("a link that climbs past the root reads as text", () => {
    const { container } = show("[out](../../x.md)");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("out");
  });

  it("a web address keeps opening in a new tab, and a refused scheme shows its label", () => {
    const { container } = show("[web](https://example.com/a) and [bad](javascript:alert(1))");
    expect(screen.getByRole("link", { name: "web" }).getAttribute("target")).toBe("_blank");
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.textContent).toBe("web and bad");
  });

  it("a reference link to a sibling opens it", () => {
    show("[go][g]\n\n[g]: ./other.md");
    fireEvent.click(screen.getByRole("link", { name: "go" }));
    expect(open).toHaveBeenCalledWith({ path: "docs/other.md" });
  });

  it("without a way to open files, a relative link reads as its label", () => {
    const { container } = show("[go](./other.md)", {});
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("go");
  });

  describe("a fragment", () => {
    const scrolled: string[] = [];
    beforeEach(() => {
      scrolled.length = 0;
      Element.prototype.scrollIntoView = function (this: Element) {
        scrolled.push(this.id);
      };
    });

    it("scrolls to the heading with that anchor, in place, with no navigation", () => {
      show("[top](#getting-started) and [jump](#usage-1)\n\n# Getting Started\n\n## Usage\n\n## Usage");
      const a = screen.getByRole("link", { name: "top" });
      expect(a.getAttribute("target")).toBeNull();
      expect(fireEvent.click(a)).toBe(false);
      fireEvent.click(screen.getByRole("link", { name: "jump" }));
      expect(scrolled).toEqual(["getting-started", "usage-1"]);
      expect(open).not.toHaveBeenCalled();
    });

    it("matches a percent-encoded or capitalised fragment", () => {
      show("[a](#Getting%20Started) [b](#GETTING-STARTED)\n\n# Getting Started");
      // `%20` is a space, and no heading slugs to a name with a space in it: nothing to scroll to.
      fireEvent.click(screen.getByRole("link", { name: "a" }));
      expect(scrolled).toEqual([]);
      fireEvent.click(screen.getByRole("link", { name: "b" }));
      expect(scrolled).toEqual(["getting-started"]);
    });

    it("an anchor nobody has does nothing", () => {
      show("[nope](#nowhere)\n\n# Heading");
      fireEvent.click(screen.getByRole("link", { name: "nope" }));
      expect(scrolled).toEqual([]);
      expect(open).not.toHaveBeenCalled();
    });

    it("works with no way to open files, and never reaches an element outside the preview", () => {
      const outside = document.createElement("div");
      outside.id = "root";
      document.body.append(outside);
      show("[r](#root)\n\n# Root", {});
      fireEvent.click(screen.getByRole("link", { name: "r" }));
      expect(scrolled).toEqual(["root"]);
      outside.remove();
    });
  });
});

describe("Preview: code draws no ligatures", () => {
  it("the JSON tree turns them off", () => {
    const { container } = render(<FileContent file={file("package.json")} view="preview" />);
    expect(container.querySelector("[data-slot='file-json']")?.className).toContain("[font-variant-ligatures:none]");
  });

  it("a README preview sets its headings as a document", () => {
    const { container } = render(<FileContent file={file("README.md")} view="preview" />);
    expect(container.querySelector("[data-heading-level='1']")?.className).toContain("text-2xl");
  });
});

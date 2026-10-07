import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { en } from "@/lib/i18n/messages/en";
import type { FilesAt } from "@/lib/nav";
import { fixtureFileRead } from "@/test/handlers";

import type { FileImageAnswer } from "@/lib/api";
import { clearHeldImages, dropHeldImages, heldImage, imageSubject } from "@/lib/file-image-cache";

import { defaultView, FileContent, type FileImages, type FileLinks, type FileText } from "./file-preview";

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
    // An SVG has a Preview, so it opens on it, as Markdown and HTML do (ADR 0090).
    expect(defaultView("icons/logo.SVG")).toBe("preview");
    // A raster picture has no Source | Preview pair: its one view is the picture.
    expect(defaultView("logo.png")).toBe("source");
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

// ── Pictures (ADR 0090) ───────────────────────────────────────────────────────────────────────────

/** A text read's answer for `path`, built on a fixture's fields. */
function textFile(path: string, text: string, over: Partial<FileText> = {}): FileText {
  return { ...file("README.md"), path, text, size: text.length, binary: false, truncated: false, ...over };
}

/** A binary file of `size` bytes at `path`, as the text read answers it. */
function binaryFile(path: string, size = 52_224): FileText {
  return { ...file("logo.png"), path, size, binary: true, text: "" };
}

/** A loader that answers every picture with `answer` and every text with `text`, and counts. */
function loader(answer: FileImageAnswer = { outcome: "image", blob: new Blob(["png"], { type: "image/png" }) }, text: string | null = "<svg/>") {
  const bytes = vi.fn<FileImages["bytes"]>(async () => answer);
  const texts = vi.fn<(path: string, signal: AbortSignal) => Promise<string | null>>(async () => text);
  const images: FileImages = { bytes, text: texts };
  return { images, bytes, texts };
}

/** Object URLs made and revoked during a test, with the blob each was made for. */
function trackObjectUrls() {
  const made: { url: string; blob: Blob }[] = [];
  const revoked: string[] = [];
  const create = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    const url = `blob:picture/${String(made.length + 1)}`;
    if (blob instanceof Blob) made.push({ url, blob });
    return url;
  });
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
    revoked.push(url);
  });
  return {
    made,
    revoked,
    restore: () => {
      create.mockRestore();
      revoke.mockRestore();
    },
  };
}

/** Fire the picture's load with a natural size, as a browser does once it has decoded it. */
function loadPicture(img: HTMLElement, width: number, height: number): void {
  Object.defineProperty(img, "naturalWidth", { configurable: true, value: width });
  Object.defineProperty(img, "naturalHeight", { configurable: true, value: height });
  fireEvent.load(img);
}

describe("a raster picture", () => {
  it("is drawn from the image read on its board, with its natural size, size and type under it", async () => {
    const { images, bytes } = loader();
    const { container } = render(<FileContent file={binaryFile("shots/home.png")} view="source" images={images} />);
    const img = await screen.findByRole("img", { name: "home.png" });
    expect(bytes).toHaveBeenCalledTimes(1);
    expect(bytes.mock.calls[0]![0]).toBe("shots/home.png");
    expect(img.getAttribute("src")).toMatch(/^blob:/);
    expect(img.className).toContain("max-h-[70dvh]");
    expect(img.className).toContain("object-contain");
    // Before the picture has drawn, the caption knows the size and the type.
    const caption = container.querySelector("figcaption")!;
    expect(caption.textContent).toBe("51 KB · PNG");
    loadPicture(img, 1200, 800);
    expect(caption.textContent).toBe("1200 × 800 · 51 KB · PNG");
    expect(screen.queryByText(/Binary file/)).toBeNull();
  });

  it("asks for each of png, jpg, jpeg, gif, webp and avif, and for nothing else", async () => {
    for (const name of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp", "f.avif"]) {
      const { images, bytes } = loader();
      render(<FileContent file={binaryFile(name)} view="source" images={images} />);
      expect(await screen.findByRole("img", { name })).toBeTruthy();
      expect(bytes).toHaveBeenCalledTimes(1);
      cleanup();
    }
    const { images, bytes } = loader();
    render(<FileContent file={binaryFile("archive.zip", 2048)} view="source" images={images} />);
    expect(screen.getByText("Binary file, 2 KB")).toBeTruthy();
    expect(bytes).not.toHaveBeenCalled();
  });

  it("with no loader, is the binary line it always was", () => {
    render(<FileContent file={binaryFile("logo.png", 20480)} view="source" />);
    expect(screen.getByText("Binary file, 20 KB")).toBeTruthy();
  });

  it.each([
    [{ outcome: "too-large" } as const, en["files.image.tooLarge"]],
    [{ outcome: "not-image" } as const, en["files.image.notImage"]],
    [{ outcome: "failed" } as const, en["files.image.failed"]],
  ])("a %o read falls back to the binary line, with the reason", async (answer, reason) => {
    const { images } = loader(answer);
    render(<FileContent file={binaryFile("big.png")} view="source" images={images} />);
    expect(await screen.findByText(reason)).toBeTruthy();
    expect(screen.getByText(/Binary file, 51 KB/)).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("a loader that throws is a failed read", async () => {
    const images: FileImages = { bytes: () => Promise.reject(new Error("offline")), text: async () => null };
    render(<FileContent file={binaryFile("a.png")} view="source" images={images} />);
    expect(await screen.findByText(en["files.image.failed"])).toBeTruthy();
  });

  it("bytes the browser cannot draw fall back to the binary line", async () => {
    const { images } = loader();
    render(<FileContent file={binaryFile("a.avif")} view="source" images={images} />);
    fireEvent.error(await screen.findByRole("img"));
    expect(screen.getByText(en["files.image.undrawable"])).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("revokes its object URL when the screen goes, and when another file takes its place", async () => {
    const urls = trackObjectUrls();
    try {
      const { images } = loader();
      const { rerender, unmount } = render(<FileContent file={binaryFile("one.png")} view="source" images={images} />);
      await screen.findByRole("img", { name: "one.png" });
      const first = urls.made.at(-1)!.url;
      expect(urls.revoked).not.toContain(first);
      rerender(<FileContent file={binaryFile("two.png")} view="source" images={images} />);
      await screen.findByRole("img", { name: "two.png" });
      expect(urls.revoked).toContain(first);
      const second = urls.made.at(-1)!.url;
      unmount();
      expect(urls.revoked).toContain(second);
      // Every URL made is revoked by the end.
      expect(urls.made.map((m) => m.url).every((u) => urls.revoked.includes(u))).toBe(true);
    } finally {
      urls.restore();
    }
  });

  it("asks again for a file read again, since its bytes may have changed under one name", async () => {
    const { images, bytes } = loader();
    const { rerender } = render(<FileContent file={binaryFile("live.png")} view="source" images={images} />);
    await screen.findByRole("img");
    rerender(<FileContent file={binaryFile("live.png", 60_000)} view="source" images={images} />);
    await waitFor(() => expect(bytes).toHaveBeenCalledTimes(2));
  });
});

describe("held pictures (ADR 0090, amended 2026-10-07)", () => {
  const SUBJECT = imageSubject(undefined, "pane:w1:p1");
  const at = (size: number, mtimeMs: number | undefined) => ({ ...binaryFile("shots/home.png", size), mtimeMs });

  /** What changes.tsx builds: the loader's fetch behind the table, filed under one pane. */
  function held() {
    const fetch = vi.fn<(path: string) => Promise<FileImageAnswer>>(async () => ({ outcome: "image", blob: new Blob(["png"], { type: "image/png" }) }));
    const images: FileImages = {
      bytes: (path, _signal, version) => heldImage(SUBJECT, path, version, () => fetch(path)),
      text: async () => null,
    };
    return { images, fetch };
  }

  beforeEach(() => clearHeldImages());

  it("hands the image read the file's version, and none when the answer has no mtime", async () => {
    const { images, bytes } = loader();
    const first = render(<FileContent file={at(1000, 77)} view="source" images={images} />);
    await screen.findByRole("img");
    expect(bytes.mock.calls[0]?.[2]).toEqual({ tag: "1000:77", own: true });
    first.unmount();
    render(<FileContent file={at(1000, undefined)} view="source" images={images} />);
    await screen.findByRole("img");
    expect(bytes.mock.calls[1]?.[2]).toBeNull();
  });

  it("opening the same picture again makes no request", async () => {
    const { images, fetch } = held();
    const first = render(<FileContent file={at(1000, 77)} view="source" images={images} />);
    await screen.findByRole("img");
    first.unmount();
    render(<FileContent file={at(1000, 77)} view="source" images={images} />);
    await screen.findByRole("img");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a changed size or mtime is another version and is fetched again", async () => {
    const { images, fetch } = held();
    const first = render(<FileContent file={at(1000, 77)} view="source" images={images} />);
    await screen.findByRole("img");
    first.unmount();
    const second = render(<FileContent file={at(1000, 78)} view="source" images={images} />);
    await screen.findByRole("img");
    second.unmount();
    render(<FileContent file={at(1001, 78)} view="source" images={images} />);
    await screen.findByRole("img");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("the refresh button's drop makes the next open fetch again", async () => {
    const { images, fetch } = held();
    const first = render(<FileContent file={at(1000, 77)} view="source" images={images} />);
    await screen.findByRole("img");
    first.unmount();
    dropHeldImages(SUBJECT);
    render(<FileContent file={at(1000, 77)} view="source" images={images} />);
    await screen.findByRole("img");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("a held blob gets a fresh object URL per view: the first view's revoked URL is never handed on", async () => {
    const urls = trackObjectUrls();
    try {
      const { images, fetch } = held();
      const first = render(<FileContent file={at(1000, 77)} view="source" images={images} />);
      const firstImg = await screen.findByRole("img");
      const firstUrl = firstImg.getAttribute("src");
      first.unmount();
      expect(urls.revoked).toContain(firstUrl);
      render(<FileContent file={at(1000, 77)} view="source" images={images} />);
      const secondUrl = (await screen.findByRole("img")).getAttribute("src");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(secondUrl).not.toBe(firstUrl);
      expect(urls.revoked).not.toContain(secondUrl);
      // Both views were made from the one held blob.
      expect(urls.made).toHaveLength(2);
      expect(urls.made[1]!.blob).toBe(urls.made[0]!.blob);
      cleanup();
      expect(urls.made.every((m) => urls.revoked.includes(m.url))).toBe(true);
    } finally {
      urls.restore();
    }
  });

  it("holds a Markdown picture under the Markdown file's version and its path", async () => {
    const { images, bytes } = loader();
    const md = textFile("docs/guide.md", "![the screen](img/home.png)", { size: 500, mtimeMs: 9 });
    const { unmount } = render(<FileContent file={md} view="preview" images={images} />);
    await screen.findByRole("img");
    expect(bytes.mock.calls[0]).toEqual(["docs/img/home.png", expect.anything(), { tag: "docs/guide.md@500:9", own: false }]);
    unmount();
    // No mtime on the Markdown file: nothing to hold the picture under.
    const bare = textFile("docs/guide.md", "![the screen](img/home.png)", { size: 500, mtimeMs: undefined });
    render(<FileContent file={bare} view="preview" images={images} />);
    await waitFor(() => expect(bytes).toHaveBeenCalledTimes(2));
    expect(bytes.mock.calls[1]?.[2]).toBeNull();
  });

  it("a Markdown picture opened again from the same Markdown version makes no request", async () => {
    const { images, fetch } = held();
    const md = textFile("docs/guide.md", "![the screen](img/home.png)", { size: 500, mtimeMs: 9 });
    const first = render(<FileContent file={md} view="preview" images={images} />);
    await screen.findByRole("img");
    first.unmount();
    render(<FileContent file={md} view="preview" images={images} />);
    await screen.findByRole("img");
    expect(fetch).toHaveBeenCalledTimes(1);
    cleanup();
    // The Markdown file changed: its pictures are asked for again.
    render(<FileContent file={{ ...md, mtimeMs: 10 }} view="preview" images={images} />);
    await screen.findByRole("img");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><script>alert(1)</script><circle r="4"/></svg>\n';

describe("an SVG", () => {
  it("previews as a picture from its own text, typed image/svg+xml, never as markup in the page", async () => {
    const urls = trackObjectUrls();
    try {
      const { container, unmount } = render(<FileContent file={textFile("icons/logo.svg", SVG)} view="preview" />);
      const img = await screen.findByRole("img", { name: "logo.svg" });
      expect(urls.made).toHaveLength(1);
      expect(urls.made[0]!.blob.type).toBe("image/svg+xml");
      expect(await urls.made[0]!.blob.text()).toBe(SVG);
      expect(img.getAttribute("src")).toBe(urls.made[0]!.url);
      // The file's own elements never reach this document.
      expect(container.querySelector("script")).toBeNull();
      expect(container.querySelector("circle")).toBeNull();
      loadPicture(img, 24, 24);
      expect(container.querySelector("figcaption")!.textContent).toBe(`24 × 24 · ${String(SVG.length)} B · SVG`);
      unmount();
      expect(urls.revoked).toEqual([urls.made[0]!.url]);
    } finally {
      urls.restore();
    }
  });

  it("shows its source on Source", () => {
    const { container } = render(<FileContent file={textFile("logo.svg", SVG)} view="source" />);
    expect(container.querySelector("[data-slot='file-source']")).not.toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("one the browser cannot draw says so", async () => {
    render(<FileContent file={textFile("broken.svg", "<svg")} view="preview" />);
    fireEvent.error(await screen.findByRole("img"));
    expect(screen.getByText(en["files.image.undrawable"])).toBeTruthy();
  });
});

describe("Preview: Markdown images", () => {
  function show(text: string, images: FileImages | undefined, path = "docs/guide.md") {
    return render(<FileContent file={textFile(path, text)} view="preview" images={images} />);
  }

  it("a relative raster image is read through the image read; an .svg through the text read", async () => {
    const { images, bytes, texts } = loader();
    show("# Guide\n\n![the screen](img/home.png)\n\n![the mark](../brand/mark.svg)", images);
    const shot = await screen.findByRole("img", { name: "the screen" });
    const mark = await screen.findByRole("img", { name: "the mark" });
    expect(bytes.mock.calls.map((c) => c[0])).toEqual(["docs/img/home.png"]);
    expect(texts.mock.calls.map((c) => c[0])).toEqual(["brand/mark.svg"]);
    expect(shot.className).toContain("max-w-full");
    expect(mark.getAttribute("src")).toMatch(/^blob:/);
  });

  it("a remote, root-absolute, escaping, .git or non-picture image stays its alt text and asks for nothing", async () => {
    const { images, bytes, texts } = loader();
    show(
      [
        "![remote](https://example.com/a.png)",
        "![proto](//example.com/a.png)",
        "![rooted](/logo.png)",
        "![home](~/a.png)",
        "![up](../../a.png)",
        "![git](.git/a.png)",
        "![data](data:image/png;base64,AAAA)",
        "![doc](notes.md)",
      ].join("\n\n"),
      images,
    );
    for (const alt of ["remote", "proto", "rooted", "home", "up", "git", "data", "doc"]) expect(screen.getByText(alt)).toBeTruthy();
    await act(async () => undefined);
    expect(screen.queryByRole("img")).toBeNull();
    expect(bytes).not.toHaveBeenCalled();
    expect(texts).not.toHaveBeenCalled();
  });

  it("an image that does not load stays its alt text", async () => {
    const { images } = loader({ outcome: "not-image" });
    show("![a fake](fake.png)", images);
    await act(async () => undefined);
    expect(screen.getByText("a fake")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("with no loader, every image is its alt text, as before", () => {
    show("![shot](img/home.png)", undefined);
    expect(screen.getByText("shot")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("loads at most the first 20 images of a document", async () => {
    const { images, bytes } = loader();
    show(Array.from({ length: 25 }, (_, i) => `![shot ${String(i)}](img/${String(i)}.png)`).join("\n\n"), images);
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(20));
    expect(bytes).toHaveBeenCalledTimes(20);
    expect(screen.getByText("shot 24")).toBeTruthy();
  });
});

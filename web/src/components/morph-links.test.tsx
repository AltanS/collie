import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FileLinksProvider, type FileLinkOpener } from "@/components/file-links";
import { MorphView, type MorphViewProps } from "@/components/morph-view";
import type { JsonValue } from "@/lib/json";
import { parseMorphView, type MorphView as MorphScreen } from "@/lib/morph/wire";

// Links in the Morph screen's text: a web address is a link, a path the bridge confirmed opens through the
// session's own opener (the one Chat uses), a path it has not confirmed stays text, and nothing inside a
// button is a link.

const AT = "2026-11-10T10:00:00.000Z";
const NOW = Date.parse("2026-11-10T10:03:00.000Z");

function screenOf(raw: JsonValue): MorphScreen {
  const parsed = parseMorphView(raw);
  if (parsed.view === undefined) throw new Error(JSON.stringify(parsed.refusals));
  return { rev: 1, at: AT, view: parsed.view };
}

const LINES = screenOf([
  { kind: "line", text: "Edit web/src/b.tsx:3 first." },
  { kind: "line", text: "Look at it at http://bluefin:5198 on your phone." },
  { kind: "list", kids: [{ kind: "row", text: "section.tsx" }, { kind: "row", text: "ghost.tsx" }] },
  { kind: "bar", kids: [{ kind: "button", attrs: { label: "Open src/a.tsx", intent: "open" } }] },
]);

function draw(opener: FileLinkOpener | null, view: MorphScreen = LINES) {
  const props: MorphViewProps = { session: "local/w1:p1#ab12", view, working: false, entries: [], canAct: true, onSend: vi.fn(() => Promise.resolve(true)), onLink: vi.fn(), now: NOW };
  return render(
    <FileLinksProvider value={opener}>
      <MorphView {...props} />
    </FileLinksProvider>,
  );
}

afterEach(cleanup);

describe("links in the Morph screen's text", () => {
  it("draws a web address as a link that opens in a new tab", () => {
    draw(null);
    const link = screen.getByRole("link", { name: "http://bluefin:5198" });
    expect(link).toHaveAttribute("href", "http://bluefin:5198");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link.className).toContain("text-primary");
  });

  it("draws a confirmed path as a file link that calls the opener, and an unconfirmed one as text", () => {
    const onOpen = vi.fn();
    const asked: string[] = [];
    const opener: FileLinkOpener = ({ path }) => {
      asked.push(path);
      return path === "section.tsx" ? { href: "/files/section.tsx", onOpen } : null;
    };
    draw(opener);
    const link = screen.getByRole("link", { name: "section.tsx" });
    expect(link).toHaveAttribute("href", "/files/section.tsx");
    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(asked).toContain("ghost.tsx");
    expect(screen.getByText("ghost.tsx")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "ghost.tsx" })).toBeNull();
  });

  it("links a path with a folder inside a sentence, with its line", () => {
    const asked: Array<{ path: string; line?: number }> = [];
    draw((found) => {
      asked.push(found);
      return found.path === "web/src/b.tsx" ? { href: "/files/b", onOpen: vi.fn() } : null;
    });
    expect(screen.getByRole("link", { name: "web/src/b.tsx:3" })).toHaveAttribute("href", "/files/b");
    expect(asked).toContainEqual(expect.objectContaining({ path: "web/src/b.tsx", line: 3 }));
  });

  it("draws no path link with no opener", () => {
    draw(null);
    expect(screen.queryByRole("link", { name: "section.tsx" })).toBeNull();
    expect(screen.getByText("section.tsx")).toBeInTheDocument();
  });

  it("leaves the text inside a button as text", () => {
    draw(() => ({ href: "/f", onOpen: vi.fn() }));
    const button = screen.getByRole("button", { name: /Open src\/a.tsx/ });
    expect(button.querySelector("a")).toBeNull();
    expect(screen.getAllByRole("link").every((link) => !button.contains(link))).toBe(true);
  });

  it("links a path that the bridge confirmed after the screen was drawn", () => {
    const view = draw(null);
    expect(screen.queryByRole("link", { name: "section.tsx" })).toBeNull();
    const onOpen = vi.fn();
    view.rerender(
      <FileLinksProvider value={({ path }) => (path === "section.tsx" ? { href: "/files/section.tsx", onOpen } : null)}>
        <MorphView session="local/w1:p1#ab12" view={LINES} working={false} entries={[]} canAct onSend={() => Promise.resolve(true)} onLink={vi.fn()} now={NOW} />
      </FileLinksProvider>,
    );
    expect(screen.getByRole("link", { name: "section.tsx" })).toBeInTheDocument();
  });
});

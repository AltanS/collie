import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FileLinksProvider, type FileLinkOpener } from "@/components/file-links";
import { AgentViewScreen, type AgentViewScreenProps } from "@/components/agent-view-screen";
import type { JsonValue } from "@/lib/json";
import { parseAgentView, type ViewScreen } from "@/lib/agent-view/wire";
import type { View } from "@/lib/tricks/schema";

// Links in an agent view's text: a web address is a link, a path the bridge confirmed opens through the
// session's own opener (the one Chat uses), a path it has not confirmed stays text, and nothing inside a
// button is a link.

const AT = "2026-11-10T10:00:00.000Z";
const NOW = Date.parse("2026-11-10T10:03:00.000Z");

function screenOf(raw: JsonValue): ViewScreen {
  const parsed = parseAgentView(raw);
  if (parsed.view === undefined) throw new Error(JSON.stringify(parsed.refusals));
  return { rev: 1, at: AT, view: parsed.view };
}

const LINES = screenOf([
  { kind: "line", text: "Edit web/src/b.tsx:3 first." },
  { kind: "line", text: "Look at it at http://workshop:5198 on your phone." },
  { kind: "list", kids: [{ kind: "row", text: "section.tsx" }, { kind: "row", text: "ghost.tsx" }] },
  { kind: "bar", kids: [{ kind: "button", attrs: { label: "Open src/a.tsx", intent: "open" } }] },
]);

const onTap = () => Promise.resolve({ sent: true, line: null, code: null });

function draw(opener: FileLinkOpener | null, view: ViewScreen = LINES) {
  const props: AgentViewScreenProps = { name: "Morph", session: "local/w1:p1#ab12", view, working: false, entries: [], canAct: true, onTap: vi.fn(onTap), onLink: vi.fn(), now: NOW };
  return render(
    <FileLinksProvider value={opener}>
      <AgentViewScreen {...props} />
    </FileLinksProvider>,
  );
}

afterEach(cleanup);

describe("links in an agent view's text", () => {
  it("draws a web address as a link that opens in a new tab", () => {
    draw(null);
    const link = screen.getByRole("link", { name: "http://workshop:5198" });
    expect(link).toHaveAttribute("href", "http://workshop:5198");
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
        <AgentViewScreen name="Morph" session="local/w1:p1#ab12" view={LINES} working={false} entries={[]} canAct onTap={onTap} onLink={vi.fn()} now={NOW} />
      </FileLinksProvider>,
    );
    expect(screen.getByRole("link", { name: "section.tsx" })).toBeInTheDocument();
  });
});

describe("rule 8: a link in an agent view shows where it goes", () => {
  it("shows the link's host beside its words, as a Decision's view does", () => {
    const { container } = draw(null, screenOf([{ kind: "para", kids: [{ kind: "link", text: "The release notes", attrs: { href: "https://example.org/notes" } }] }]));
    const link = screen.getByRole("link", { name: /The release notes/ });
    expect(link).toHaveAttribute("href", "https://example.org/notes");
    expect(container.querySelector("[data-slot=view-screen]")?.textContent).toContain("example.org");
  });

  it("shows the target in place of words that read as another address", () => {
    // The parser refuses such a link; a screen built past it still draws the truth.
    const view: View = [{ kind: "para", kids: [{ kind: "link", text: "https://bank.example/login", attrs: { href: "https://other.example/x" } }] }];
    draw(null, { rev: 1, at: AT, view });
    expect(screen.queryByText("https://bank.example/login")).toBeNull();
    expect(screen.getByRole("link", { name: /https:\/\/other\.example\/x/ })).toHaveAttribute("href", "https://other.example/x");
  });

  it("refuses a button that copies and a link whose words read as another address", () => {
    const copies = parseAgentView([{ kind: "bar", kids: [{ kind: "button", attrs: { label: "Copy", intent: "copy", does: "copy" } }] }]);
    expect(copies.view).toBeUndefined();
    expect(copies.refusals.map((r) => r.reason).join(" ")).toContain("does");
    const lies = parseAgentView([{ kind: "para", kids: [{ kind: "link", text: "https://bank.example", attrs: { href: "https://other.example" } }] }]);
    expect(lies.view).toBeUndefined();
    expect(parseAgentView([{ kind: "para", kids: [{ kind: "link", text: "https://other.example", attrs: { href: "https://other.example" } }] }]).view).toBeDefined();
  });
});

describe("review 10 W10: a bare web address in an agent view's text shows where it goes", () => {
  it("W10: a bare address is followed by its host", () => {
    const { container } = draw(null, screenOf([{ kind: "line", text: "The notes are at https://docs.example/notes/today now." }]));
    const link = screen.getByRole("link", { name: "https://docs.example/notes/today" });
    const host = link.nextElementSibling;
    expect(host?.hasAttribute("data-trick-link-host")).toBe(true);
    expect(host?.textContent).toBe("docs.example");
    expect(container.querySelector("[data-slot=view-screen]")?.textContent).toContain("now.");
  });

  it("W10: an address with a user part (https://bank@evil) shows the host it really goes to", () => {
    draw(null, screenOf([{ kind: "line", text: "Log in at https://bank.example@evil.example/login please." }]));
    const link = screen.getByRole("link", { name: /bank\.example@evil\.example/ });
    expect(link.getAttribute("href")).toContain("evil.example");
    expect(link.nextElementSibling?.textContent).toBe("evil.example");
  });
});

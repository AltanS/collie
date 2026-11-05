import { render, screen } from "@testing-library/react";

import { PaneGlyph } from "./pane-glyph";
import type { AgentView } from "@/lib/types";

const agent: AgentView = {
  paneId: "w1:p1",
  workspaceId: "w1",
  workspaceLabel: "webapp",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "claude",
  status: "working",
  cwd: "/home/you/webapp",
  focused: false,
};
const shell: AgentView = { ...agent, paneId: "w1:p2", kind: "shell", agent: "shell", status: "unknown" };

describe("PaneGlyph", () => {
  it("draws the glyph alone, with no wrapper and no mark, when it is given no surface", () => {
    const { container } = render(<PaneGlyph pane={agent} className="size-5" />);
    const svg = container.firstElementChild;
    expect(svg?.tagName.toLowerCase()).toBe("svg");
    expect(svg?.getAttribute("class")).toContain("size-5");
    expect(container.querySelector("[class*='text-status-']")).toBeNull();
  });

  it("draws the terminal square for a bare shell", () => {
    const { container } = render(<PaneGlyph pane={shell} />);
    const svg = container.firstElementChild;
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("class")).toContain("text-muted-foreground");
  });

  it("puts the pane's status mark on the glyph's corner, backed with the surface it is given", () => {
    const { container } = render(<PaneGlyph pane={agent} markOn="bg-card" />);
    const wrapper = container.firstElementChild;
    expect(wrapper?.getAttribute("class")).toContain("relative");
    const mark = wrapper?.querySelector(".text-status-working");
    expect(mark?.getAttribute("class")).toContain("absolute");
    // Backed: the surface disc is painted behind the shape, so the logo never shows through it.
    expect(mark?.querySelector(".bg-card")).not.toBeNull();
    // Unnamed: the control around it says the status.
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
  });

  it("draws the status the pane SHOWS: a finished pane that was opened rests as idle", () => {
    const seen: AgentView = { ...agent, status: "done", lastActiveAt: 1, lastSeenAt: 2 };
    const { container } = render(<PaneGlyph pane={seen} markOn="bg-card" />);
    expect(container.querySelector(".text-status-idle")).not.toBeNull();
    expect(container.querySelector(".text-status-done")).toBeNull();
  });

  it("names the mark with the status word when asked", () => {
    render(<PaneGlyph pane={agent} markOn="bg-card" named />);
    expect(screen.getByRole("img", { name: "working" })).toBeInTheDocument();
  });
});

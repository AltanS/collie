import { render, screen } from "@testing-library/react";

import { AgentIcon } from "./agent-icon";

describe("AgentIcon", () => {
  it.each(["claude", "codex", "pi", "opencode"])(
    "renders the %s brand logo as an inline-SVG app-icon tile",
    (agent) => {
      const { container } = render(<AgentIcon agent={agent} />);
      const svg = container.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg!.querySelector("path")).not.toBeNull();
      // The tile carries its own solid brand background (theme-independent contrast).
      expect(svg!.querySelector("rect")?.getAttribute("fill")).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(screen.getByRole("img", { name: `${agent} logo` })).toBeInTheDocument();
    },
  );

  it.each([
    ["claude-code"],
    ["codex-cli"],
    ["opencode-dev"],
    ["pi-go"],
    ["PI"],
  ])("resolves label variant '%s' to a brand logo", (variant) => {
    const { container } = render(<AgentIcon agent={variant} />);
    expect(container.querySelector("svg path")).not.toBeNull();
  });

  it("falls back to an initials tile for unknown agents", () => {
    render(<AgentIcon agent="gemini" />);
    const el = screen.getByRole("img", { name: "gemini icon" });
    expect(el).toHaveTextContent("GE");
    expect(el.querySelector("svg")).toBeNull(); // fallback is text, not a brand mark
  });

  it("renders a fallback (no crash) for null / undefined agents", () => {
    const { rerender } = render(<AgentIcon agent={null} />);
    expect(screen.getByRole("img")).toBeInTheDocument();
    rerender(<AgentIcon agent={undefined} />);
    expect(screen.getByRole("img")).toBeInTheDocument();
  });

  it("forwards className for sizing", () => {
    const { container } = render(<AgentIcon agent="claude" className="size-9" />);
    expect(container.querySelector("svg")?.getAttribute("class")).toContain("size-9");
  });
});

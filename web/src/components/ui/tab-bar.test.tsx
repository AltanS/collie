import { render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TabBar } from "./tab-bar";

type V = "panes" | "needs" | "changes";

function renderBar(active: V, badge: number, onSelect = vi.fn()) {
  const { container } = render(
    <TabBar<V>
      label="Dashboard views"
      active={active}
      onSelect={onSelect}
      items={[
        { value: "panes", label: "Panes", icon: <span /> },
        { value: "needs", label: "Needs you", icon: <span />, badge, badgeLabel: `${badge} need you` },
        { value: "changes", label: "Changes", icon: <span /> },
      ]}
    />,
  );
  return { bar: within(container), onSelect };
}

describe("TabBar", () => {
  it("marks exactly the active tab as the current page", () => {
    const { bar } = renderBar("needs", 0);
    expect(bar.getByRole("button", { name: "Needs you" })).toHaveAttribute("aria-current", "page");
    expect(bar.getByRole("button", { name: "Panes" })).not.toHaveAttribute("aria-current");
    expect(bar.getByRole("button", { name: "Changes" })).not.toHaveAttribute("aria-current");
  });

  it("hands the tapped tab's value to onSelect", async () => {
    const { bar, onSelect } = renderBar("panes", 0);
    await userEvent.click(bar.getByRole("button", { name: "Changes" }));
    expect(onSelect).toHaveBeenCalledWith("changes");
  });

  it("draws no badge at zero", () => {
    const { bar } = renderBar("panes", 0);
    expect(bar.getByRole("button", { name: "Needs you" }).textContent).toBe("Needs you");
  });

  it("draws the badge above zero, and names it for a screen reader", () => {
    const { bar } = renderBar("panes", 2);
    const tab = bar.getByRole("button", { name: /Needs you/ });
    expect(tab).toHaveTextContent("2");
    expect(tab).toHaveAccessibleName("Needs you, 2 need you");
  });

  it("reserves the active edge on every tab, so a switch only recolours it (DESIGN.md §2)", () => {
    const { bar } = renderBar("panes", 0);
    for (const b of bar.getAllByRole("button")) {
      expect(b.className).toMatch(/\bborder-t-2\b/u);
      expect(b.className).toMatch(/\bmin-h-14\b/u);
    }
  });
});

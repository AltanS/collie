import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TabBar } from "./tab-bar";

type V = "panes" | "focus" | "changes";

function renderBar(active: V, badge: number, onSelect = vi.fn(), dot = false) {
  const { container } = render(
    <TabBar<V>
      label="Dashboard views"
      active={active}
      onSelect={onSelect}
      items={[
        { value: "panes", label: "Panes", icon: <span /> },
        { value: "focus", label: "Focus", icon: <span />, badge, dot, badgeLabel: badge > 0 ? `${badge} blocked` : "finished panes unseen" },
        { value: "changes", label: "Changes", icon: <span /> },
      ]}
    />,
  );
  return { bar: within(container), onSelect };
}

describe("TabBar", () => {
  it("marks exactly the active tab as the current page", () => {
    const { bar } = renderBar("focus", 0);
    expect(bar.getByRole("button", { name: "Focus" })).toHaveAttribute("aria-current", "page");
    expect(bar.getByRole("button", { name: "Panes" })).not.toHaveAttribute("aria-current");
    expect(bar.getByRole("button", { name: "Changes" })).not.toHaveAttribute("aria-current");
  });

  it("hands the tapped tab's value to onSelect", async () => {
    const { bar, onSelect } = renderBar("panes", 0);
    await userEvent.click(bar.getByRole("button", { name: "Changes" }));
    expect(onSelect).toHaveBeenCalledWith("changes");
  });

  it("draws no badge and no dot at zero", () => {
    const { bar } = renderBar("panes", 0);
    const tab = bar.getByRole("button", { name: "Focus" });
    expect(tab.textContent).toBe("Focus");
    expect(tab.querySelector('[data-slot="tab-dot"]')).toBeNull();
  });

  it("draws the badge above zero, and names it for a screen reader", () => {
    const { bar } = renderBar("panes", 2);
    const tab = bar.getByRole("button", { name: /Focus/ });
    expect(tab).toHaveTextContent("2");
    expect(tab).toHaveAccessibleName("Focus, 2 blocked");
    expect(tab.querySelector('[data-slot="tab-dot"]')).toBeNull();
  });

  it("draws the quiet dot and no number when only the dot is asked for", () => {
    const { bar } = renderBar("panes", 0, vi.fn(), true);
    const tab = bar.getByRole("button", { name: /Focus/ });
    expect(tab.querySelector('[data-slot="tab-dot"]')).not.toBeNull();
    expect(tab.querySelector('[data-slot="tab-badge"]')).toBeNull();
    expect(tab.textContent).not.toMatch(/\d/u);
    expect(tab).toHaveAccessibleName("Focus, finished panes unseen");
  });

  it("lets the count win when both are asked for: never a number and a dot together", () => {
    const { bar } = renderBar("panes", 3, vi.fn(), true);
    const tab = bar.getByRole("button", { name: /Focus/ });
    expect(tab.querySelector('[data-slot="tab-badge"]')).toHaveTextContent("3");
    expect(tab.querySelector('[data-slot="tab-dot"]')).toBeNull();
  });

  it("puts the count and the dot in the same absolutely placed corner slot, so nothing shifts", () => {
    for (const [badge, dot] of [[2, false], [0, true]] as const) {
      const { bar } = renderBar("panes", badge, vi.fn(), dot);
      const tab = bar.getByRole("button", { name: /Focus/ });
      const mark = tab.querySelector('[data-slot="tab-badge"], [data-slot="tab-dot"]');
      expect(mark?.className).toMatch(/\babsolute\b/u);
      cleanup();
    }
  });

  it("reserves the active edge on every tab, so a switch only recolours it (DESIGN.md §2)", () => {
    const { bar } = renderBar("panes", 0);
    for (const b of bar.getAllByRole("button")) {
      expect(b.className).toMatch(/\bborder-t-2\b/u);
      expect(b.className).toMatch(/\bmin-h-14\b/u);
    }
  });
});

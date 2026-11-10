import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TabBar, TabBarExtraItem, type TabBarExtra, type TabBarLink } from "./tab-bar";

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

describe("TabBar's links and its scrolling run (2026-11-10)", () => {
  const ITEMS = [
    { value: "panes" as const, label: "Panes", icon: <span /> },
    { value: "focus" as const, label: "Focus", icon: <span /> },
  ];
  function renderModes(opts: { badge?: number; extras?: TabBarExtra[]; onHill?: () => void }) {
    const hill: TabBarLink = { id: "hill", label: "Hill", icon: <span />, badge: opts.badge, badgeLabel: `${opts.badge ?? 0} waiting`, onSelect: opts.onHill ?? vi.fn() };
    const { container } = render(<TabBar<"panes" | "focus"> label="Views" active="focus" onSelect={vi.fn()} items={ITEMS} links={[hill]} extras={opts.extras} />);
    const nav = container.querySelector<HTMLElement>('[data-slot="tab-bar"]')!;
    return { nav, bar: within(container), link: container.querySelector<HTMLElement>('[data-slot="tab-link"]')! };
  }
  const extra = (key: string, onSelect?: () => void): TabBarExtra => ({ key, node: <TabBarExtraItem label={key} icon={<span />} name={key} badge={3} onSelect={onSelect} /> });

  it("shares the width equally with no extras: the tabs and the link are flex-1, and nothing scrolls", () => {
    const { nav } = renderModes({});
    expect(nav.dataset.mode).toBe("equal");
    for (const cell of nav.querySelectorAll<HTMLElement>('[data-slot="tab"], [data-slot="tab-link"]')) expect(cell.className).toMatch(/\bflex-1\b/u);
    expect(nav.querySelector('[data-slot="tab-bar-extras"]')).toBeNull();
    expect(nav.querySelector('[data-slot="tab-bar-divider"]')).toBeNull();
  });

  it("pins the tabs and the link at a fixed width with extras, and puts the extras after a divider in a scroller", () => {
    const { nav } = renderModes({ extras: [extra("legs"), extra("tracker")] });
    expect(nav.dataset.mode).toBe("scroll");
    for (const cell of nav.querySelectorAll<HTMLElement>('[data-slot="tab"], [data-slot="tab-link"]')) {
      expect(cell.className).toMatch(/\bw-16\b/u);
      expect(cell.className).toMatch(/\bshrink-0\b/u);
      expect(cell.className).not.toMatch(/\bflex-1\b/u);
    }
    const run = nav.querySelector<HTMLElement>('[data-slot="tab-bar-extras"]')!;
    expect(run.className).toMatch(/\boverflow-x-auto\b/u);
    expect(run.className).toContain("[scrollbar-width:none]");
    // The house fade wraps the run (ui/overflow-edges.tsx), and the divider sits before it.
    expect(run.closest("[data-overflow]")).not.toBeNull();
    expect(nav.querySelector('[data-slot="tab-bar-divider"]')!.compareDocumentPosition(run) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect([...run.querySelectorAll('[data-slot="tab-extra"]')].map((el) => el.querySelector(".max-w-full.truncate")?.textContent)).toEqual(["legs", "tracker"]);
  });

  it("never draws the link as the selected tab, in either mode", () => {
    for (const extras of [undefined, [extra("legs")]]) {
      const { link } = renderModes({ badge: 2, extras });
      expect(link).not.toHaveAttribute("aria-current");
      expect(link.className).not.toMatch(/\bborder-foreground\b/u);
      expect(link.className).toMatch(/\bborder-t-2\b/u);
      cleanup();
    }
  });

  it("gives the link the red count only while it is above zero, and its words to a screen reader", () => {
    const zero = renderModes({ badge: 0 });
    expect(zero.link.querySelector('[data-slot="tab-badge"]')).toBeNull();
    expect(zero.link).toHaveAccessibleName("Hill");
    cleanup();
    const three = renderModes({ badge: 3 });
    expect(three.link.querySelector('[data-slot="tab-badge"]')).toHaveTextContent("3");
    expect(three.link.querySelector('[data-slot="tab-badge"]')!.className).toMatch(/\bbg-status-blocked\b/u);
    expect(three.link).toHaveAccessibleName("Hill, 3 waiting");
  });

  it("hands a link's tap to its own handler, never to onSelect", async () => {
    const onHill = vi.fn();
    const { link } = renderModes({ onHill });
    await userEvent.click(link);
    expect(onHill).toHaveBeenCalledOnce();
  });

  it("draws an extra's badge quiet and outlined, never red, and an extra with no tap as no control", async () => {
    const onSelect = vi.fn();
    const { nav } = renderModes({ extras: [extra("legs", onSelect), extra("quiet")] });
    const [legs, quiet] = [...nav.querySelectorAll<HTMLElement>('[data-slot="tab-extra"]')];
    const badge = legs!.querySelector<HTMLElement>('[data-slot="tab-extra-badge"]')!;
    expect(badge.className).toMatch(/\bborder-border\b/u);
    expect(badge.className).not.toMatch(/\bbg-status-blocked\b/u);
    expect(legs!.tagName).toBe("BUTTON");
    await userEvent.click(legs!);
    expect(onSelect).toHaveBeenCalledOnce();
    expect(quiet!.tagName).toBe("SPAN");
    expect(quiet!.textContent).toContain("quiet");
  });

  it("keeps every cell the same 56px row in both modes, so the bar's height never changes", () => {
    const { nav } = renderModes({ extras: [extra("legs")] });
    for (const cell of nav.querySelectorAll<HTMLElement>('[data-slot="tab"], [data-slot="tab-link"], [data-slot="tab-extra"]')) expect(cell.className).toMatch(/\bmin-h-14\b/u);
  });
});

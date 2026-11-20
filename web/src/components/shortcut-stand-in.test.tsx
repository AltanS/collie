import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ACTIONS, type ActionId } from "@/lib/shortcuts/actions";
import { buildKeymap } from "@/lib/shortcuts/keymap";

import { ShortcutModeBar } from "./shortcut-mode-bar";
import { shortcutRows } from "./shortcut-list";

// THE ACTIONS PALETTE OFF (Settings): the key that opened it runs Switch pane, and the bar and the list
// name it so. The keymap holds the answer (lib/shortcuts/keymap.ts, `disabled`), and both read it.

const AVAILABLE = new Set<ActionId>(["open_actions", "switch_pane", "new_tab"]);
const on = () => buildKeymap({ defaults: ACTIONS });
const off = () => buildKeymap({ defaults: ACTIONS, disabled: new Set<ActionId>(["open_actions"]) });

describe("the shortcut list", () => {
  it("lists Open Actions on prefix+g while on", () => {
    const rows = shortcutRows(on());
    expect(rows.find((row) => row.id === "open_actions")?.combos.map((combo) => combo.caps)).toEqual([["g"]]);
    expect(rows.find((row) => row.id === "switch_pane")?.combos).toEqual([]);
  });

  it("lists the same key as Switch pane while off, and no Open Actions row", () => {
    const rows = shortcutRows(off());
    expect(rows.some((row) => row.id === "open_actions")).toBe(false);
    expect(rows.some((row) => row.label === "Open Actions")).toBe(false);
    const switchRow = rows.find((row) => row.id === "switch_pane");
    expect(switchRow?.label).toBe("Switch pane");
    expect(switchRow?.combos.map((combo) => combo.caps)).toEqual([["g"]]);
  });
});

describe("the prefix bar", () => {
  it("names prefix+g Open Actions while on, and Switch pane while off", () => {
    const { container, rerender } = render(<ShortcutModeBar mode="prefix" keymap={on()} available={AVAILABLE} />);
    expect(screen.getByText("Open Actions")).toBeInTheDocument();
    expect(screen.queryByText("Switch pane")).toBeNull();
    rerender(<ShortcutModeBar mode="prefix" keymap={off()} available={AVAILABLE} />);
    expect(screen.queryByText("Open Actions")).toBeNull();
    expect(screen.getByText("Switch pane")).toBeInTheDocument();
    expect(container.querySelector('[data-slot="shortcut-hints"] kbd')?.textContent).toBe("g");
  });
});

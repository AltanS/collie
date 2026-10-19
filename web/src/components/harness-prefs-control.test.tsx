import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { HarnessPrefsControl } from "@/components/harness-prefs-control";
import { registeredAgents } from "@/lib/harness/registry";
import { __resetHarnessPrefs, harnessStatusLineShown, prefKey } from "@/lib/harness-prefs";

describe("HarnessPrefsControl", () => {
  beforeEach(() => __resetHarnessPrefs());
  afterEach(() => __resetHarnessPrefs());

  it("lists one row per harness in the adapter registry, Claude Code first, every switch on", () => {
    const { container } = render(<HarnessPrefsControl />);
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-harness]"));
    expect(rows.map((r) => r.dataset.harness)).toEqual([...new Set(registeredAgents().map(prefKey))]);
    expect(registeredAgents()[0]).toBe("claude");
    expect(within(rows[0]!).getByText("Claude Code")).toBeInTheDocument();
    for (const sw of screen.getAllByRole("switch")) expect(sw).toBeChecked();
    expect(screen.getAllByText("Show the status line")).toHaveLength(rows.length);
  });

  it("shows agy and antigravity as one row, named Antigravity", () => {
    const { container } = render(<HarnessPrefsControl />);
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-harness]"));
    const names = rows.map((r) => r.firstElementChild!.firstElementChild!.textContent);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((n) => n === "Antigravity")).toHaveLength(1);
    expect(rows.map((r) => r.dataset.harness)).not.toContain("agy");
  });

  it("a toggle writes the pref for that harness only", async () => {
    const user = userEvent.setup();
    render(<HarnessPrefsControl />);

    await user.click(screen.getByRole("switch", { name: /Claude Code/ }));

    expect(harnessStatusLineShown("claude")).toBe(false);
    expect(harnessStatusLineShown("codex")).toBe(true);
    expect(screen.getByRole("switch", { name: /Claude Code/ })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: /Codex/ })).toBeChecked();

    await user.click(screen.getByRole("switch", { name: /Claude Code/ }));
    expect(harnessStatusLineShown("claude")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { en } from "../i18n/messages/en";
import { ACTIONS, GROUPS, MODES } from "./actions";

// The glossary (docs/terminology.md) names the things the shortcuts move: a space, a tab, a pane in
// the row of panes. These words name other things (the switcher is the Spaces control of the dashboard header; the
// rest are Herdr's or the old code's), and a label that uses one reads as a different feature. Whole words, any case, and the plural.
const BANNED = ["workspace", "column", "zoom", "switcher"] as const;

const BANNED_WORD = new RegExp(`\\b(${BANNED.join("|")})s?\\b`, "iu");

/** Every English string of the feature: labels, groups, modes, the bar, the list, the hint. */
function shortcutStrings(): [key: string, text: string][] {
  const wanted = new Set<string>([
    ...ACTIONS.map((action) => action.labelKey),
    ...GROUPS.map((group) => group.labelKey),
    ...MODES.map((mode) => mode.labelKey),
  ]);
  return Object.entries(en).filter(([key]) => key.startsWith("shortcuts.") || wanted.has(key));
}

describe("the words of the shortcuts", () => {
  it("reads every action label, group, mode, bar and hint string", () => {
    const keys = shortcutStrings().map(([key]) => key);
    expect(keys.length).toBeGreaterThan(ACTIONS.length + GROUPS.length + MODES.length);
    expect(keys).toContain("shortcuts.bar.panes");
    expect(keys).toContain("shortcuts.hint.body");
  });

  it("uses none of the banned words", () => {
    for (const [key, text] of shortcutStrings()) expect(BANNED_WORD.test(text), `${key}: ${text}`).toBe(false);
  });

  it("catches a banned word in any case, and a plural, but not a longer word", () => {
    expect(BANNED_WORD.test("Close this Column")).toBe(true);
    expect(BANNED_WORD.test("workspaces")).toBe(true);
    expect(BANNED_WORD.test("ZOOM")).toBe(true);
    expect(BANNED_WORD.test("columnar")).toBe(false);
  });
});

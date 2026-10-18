// Shared row helpers for the Kiro CLI V3 grammars: the profile's frame anchors, the divider every
// panel and the composer draw, and the tail footer that marks an approval panel as owning the
// keyboard. Pure functions over parsed lines, no I/O.

import { lastNonBlankIndex, lineText, type StyledLine } from "../../blocks";
import { frameEdge, type IdleProfile } from "../../surface/frame";
import { requireProfile } from "../../surface/profile";

/** The Kiro profile's input-frame anchors (lib/surface/profiles/kiro.json). The bridge's Send Protocol
 *  reads the same profile, so the phone and the bridge find the same box and the same divider. */
export const KIRO_IDLE: IdleProfile = requireProfile("kiro").idle;

/** Plain terminal rows with right padding removed, without changing leading columns. */
export function frameRows(lines: StyledLine[]): string[] {
  return lines.map((line) => lineText(line).replace(/ +$/, ""));
}

/** The full-width divider above and below a Kiro panel: the profile's top edge. ASCII and labelled
 *  dividers have no captures yet. */
export function isDivider(row: string): boolean {
  return frameEdge(row, KIRO_IDLE) === "top";
}

/**
 * Which footer a tail panel prints: `select` and `trust` are the two captured one-row spellings of
 * an approval menu, `select-wrapped` the 40-column one, and `other` any other Escape footer (an
 * editor's `esc to close`, a page's `esc to go back`).
 */
export type PanelFooter = "select" | "trust" | "select-wrapped" | "other";

// The two footers a lifted panel prints, as captured. Highlighting `Always allow` swaps the first for
// the second before Enter opens its trust page.
const ONE_ROW_FOOTERS = new Map<string, PanelFooter>([
  [" esc to close · ↑↓ to navigate · ↵ to select · Tab to edit", "select"],
  [" esc to close · Enter to see more options", "trust"],
]);

/** A tail panel's lower divider, its last row, and the footer between them. */
interface PanelTail {
  divider: number;
  end: number;
  footer: PanelFooter;
}

/** Positive modal evidence, independent of whether the panel's contents can be lifted. */
export function readPanelTail(rows: string[]): PanelTail | null {
  const end = lastNonBlankIndex(rows);
  for (let divider = end - 1; divider >= Math.max(0, end - 3); divider--) {
    const row = rows[divider];
    if (row === undefined || !isDivider(row)) continue;
    const footer = rows.slice(divider + 1, end + 1);
    const first = footer[0] ?? "";
    if (footer.length === 1 && /^ esc to (?:close|go back)(?: · .*)?$/.test(first)) {
      return { divider, end, footer: ONE_ROW_FOOTERS.get(first) ?? "other" };
    }
    // Panel lays the Escape hint and the navigation hints in separate columns. At 40 columns
    // "close" wraps under "esc to", rather than after the navigation text (capture notes).
    if (footer.length === 2 && /^ esc to +· ↑↓ to navigate · ↵ to$/.test(first) && /^ close +select · Tab to edit$/.test(footer[1] ?? "")) {
      return { divider, end, footer: "select-wrapped" };
    }
  }
  return null;
}

/** Whether a Kiro panel footer owns the keyboard at the buffer tail. */
export function modalOnScreen(lines: StyledLine[]): boolean {
  return readPanelTail(frameRows(lines)) !== null;
}

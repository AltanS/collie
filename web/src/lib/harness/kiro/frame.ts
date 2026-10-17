import { lineText, type StyledLine } from "../../blocks";

/** Plain terminal rows with right padding removed, without changing leading columns. */
export function frameRows(lines: StyledLine[]): string[] {
  return lines.map((line) => lineText(line).replace(/ +$/, ""));
}

/** The last row containing visible text, or -1 on an empty screen. */
export function lastVisibleRow(rows: string[]): number {
  let end = rows.length - 1;
  while (end >= 0 && rows[end]?.trim() === "") end--;
  return end;
}

/** Kiro's full-width Unicode divider. ASCII and labelled dividers have no captures yet. */
export function isDivider(row: string): boolean {
  return /^─{20,}$/.test(row);
}

/** A tail panel's divider and Escape footer, including the captured 40-column wrapped spelling. */
export interface PanelTail {
  divider: number;
  end: number;
  footer: string[];
}

/** Positive modal evidence, independent of whether the panel's contents can be lifted. */
export function readPanelTail(rows: string[]): PanelTail | null {
  const end = lastVisibleRow(rows);
  for (let divider = end - 1; divider >= Math.max(0, end - 3); divider--) {
    const row = rows[divider];
    if (row === undefined || !isDivider(row)) continue;
    const footer = rows.slice(divider + 1, end + 1);
    const first = footer[0] ?? "";
    if (/^ esc to (?:close|go back)(?: · .*)?$/.test(first) && footer.length === 1) {
      return { divider, end, footer };
    }
    // Panel lays the Escape hint and the navigation hints in separate columns. At 40 columns
    // "close" wraps under "esc to", rather than after the navigation text (capture notes).
    if (
      footer.length === 2 &&
      /^ esc to +· ↑↓ to navigate · ↵ to$/.test(first) &&
      /^ close +select · Tab to edit$/.test(footer[1] ?? "")
    ) {
      return { divider, end, footer };
    }
  }
  return null;
}

/** Whether a Kiro panel footer owns the keyboard at the buffer tail. */
export function modalOnScreen(lines: StyledLine[]): boolean {
  return readPanelTail(frameRows(lines)) !== null;
}

// THE DASHBOARD ON A LARGE SCREEN, the numbers (ADR 0158).
//
// A Space keeps ONE fixed width, the column of a large phone, and Spaces wrap across the free width. The
// count of columns is a function of the width the dashboard is given and nothing else: no status, no row
// count, no name can change it, so a Space never changes column while the window keeps its size. The order
// is the list's own (machine, then Space number, then tab place, lib/pane-groups.ts), the order the phone
// list and the large screen's sidebar already show.
//
// The grid begins in the `expanded` width class (900px, ADR 0120) and never in `medium`: two columns need
// 2 × 384 + 24 + 2 × 24 = 840px, which the class's 900px floor always holds. Below the class, and with
// Large-screen layout Off, the dashboard is the phone's column, exactly as it was.

import { groupHost } from "@/lib/dash-view";
import type { WorkspaceGroup } from "@/lib/pane-groups";
import { needsYou } from "@/lib/triage";
import type { AgentView } from "@/lib/types";

/** One Space's width in px: the content column of a 412px phone (380px) rounded up to 24rem. */
export const SPACE_WIDTH = 384;
/** The air between two Space columns, in px. */
export const SPACE_GAP_X = 24;
/** The air between two Spaces in one column, in px: the phone list's own `gap-5`. */
export const SPACE_GAP_Y = 20;
/** The page gutter at large widths, in px (`px-6`). The phone keeps its 16px. */
export const WIDE_GUTTER = 24;
/** The most columns, whatever the width: past six, a line of Space headings is too long a read for one glance. */
export const MAX_SPACE_COLUMNS = 6;

/** How many Space columns a screen of `screenWidth` px holds: at least 1, at most {@link MAX_SPACE_COLUMNS}. */
export function spaceColumns(screenWidth: number): number {
  const room = screenWidth - 2 * WIDE_GUTTER + SPACE_GAP_X;
  const fits = Math.floor(room / (SPACE_WIDTH + SPACE_GAP_X));
  return Math.min(MAX_SPACE_COLUMNS, Math.max(1, fits));
}

/** The width in px of `columns` Space columns and the gaps between them: the grid's own box, centred on the screen. */
export function gridWidth(columns: number): number {
  return columns * SPACE_WIDTH + (columns - 1) * SPACE_GAP_X;
}

/** The width in px of the dashboard's column on a screen that holds `columns` Space columns: the grid and its two gutters. The header and the tab bar are this wide. */
export function contentWidth(columns: number): number {
  return gridWidth(columns) + 2 * WIDE_GUTTER;
}

/**
 * Items cut into at most `columns` runs in their order, the first runs one longer when the count does not
 * divide: a short list read down one column, then the next. The Pinned rows, which are one list and keep
 * their order top to bottom.
 */
export function runsIntoColumns<T>(items: readonly T[], columns: number): T[][] {
  const n = Math.max(1, Math.min(columns, items.length));
  const out: T[][] = [];
  let at = 0;
  for (let c = 0; c < n; c += 1) {
    const take = Math.ceil((items.length - at) / (n - c));
    out.push(items.slice(at, at + take));
    at += take;
  }
  return out;
}

/** The Spaces of one machine, in the list's order. Solo, there is one run with host `""`. */
export interface MachineRun<G> {
  readonly host: string;
  readonly items: readonly G[];
}

/** The groups cut where the machine changes. The list is already machine-first (the lead first), so each machine is one run. */
export function machineRuns<G extends { group: WorkspaceGroup }>(items: readonly G[]): MachineRun<G>[] {
  const out: { host: string; items: G[] }[] = [];
  for (const item of items) {
    const host = groupHost(item.group);
    const last = out.at(-1);
    if (last !== undefined && last.host === host) {
      last.items.push(item);
      continue;
    }
    out.push({ host, items: [item] });
  }
  return out;
}

/**
 * The sessions the band above the grid repeats: every one that needs the person or finished unseen, in the
 * list's own order (machine, Space, tab, position), never by urgency or age, so the band does not reshuffle
 * while a person reads it. A copy: no row leaves its Space (ADR 0158). `needs` says who needs you, the live
 * `needsYou` unless the list is held under a finger (`AgentList` hands the answer the finger found).
 */
export function waitingPanes(groups: readonly WorkspaceGroup[], needs: (pane: AgentView) => boolean = needsYou): AgentView[] {
  return groups.flatMap((group) => group.panes).filter(needs);
}

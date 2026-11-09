import { launchersKey, type LaunchersState } from "@/lib/launchers";
import { offerFor, type OfferItem } from "@/lib/new-page";
import type { Scope } from "@/lib/scope";

// THE NEW TAB SHEET'S ROWS (M91). The "+" of a workspace's tab row and of a dashboard heading open a
// sheet that lists the machine's launcher rows, so an agent is one tap away instead of a bare shell
// and a typed command. The rows are the New page's, in its order, built by the same `offerFor`: the
// agents (the ones Collie knows and the agent rows), then the command rows. The shell is the sheet's
// own last row, so it is left out here, and so are a durable program's starters: a machine that offers
// only those makes no tab by hand, and its "+" keeps its New page link (tab-strip.tsx).

/** One row of the sheet: a New page item, and whether it is one of the lead's rows offered here (ADR 0127). */
export interface SheetRow extends OfferItem {
  fromLead: boolean;
}

export interface SheetRows {
  agents: readonly SheetRow[];
  commands: readonly SheetRow[];
}

const NONE: SheetRows = { agents: [], commands: [] };

/** Whether `state` is the answer for `scope`, and not the last machine's rows still on hand. */
export function launchersLoaded(state: LaunchersState, scope: Scope | undefined): boolean {
  return state.loadedFor === launchersKey(scope);
}

/**
 * The sheet's rows for one machine's answer. Nothing before the answer is in: a sheet must never list
 * one machine's agents under another's workspace.
 */
export function sheetRows(state: LaunchersState, scope: Scope | undefined): SheetRows {
  if (!launchersLoaded(state, scope)) return NONE;
  const offer = offerFor({
    harnesses: state.harnesses,
    items: state.items,
    loaded: true,
    rows: state.launchers,
    // Worktrees and one-off lines are the New page's, never the sheet's.
    canWorktree: false,
  });
  if (offer.startersOnly) return NONE;
  const fromLead = new Set((state.items ?? []).filter((i) => i.from === "lead").map((i) => i.key));
  const row = (item: OfferItem): SheetRow => ({ ...item, fromLead: fromLead.has(item.key) });
  return {
    agents: offer.agents.map(row),
    commands: offer.commands.filter((c) => c.what.kind !== "shell").map(row),
  };
}

/**
 * Whether the sheet has anything to offer beyond "Just a shell": one row that can start now. The bridge
 * lists every agent Collie knows, installed or not (bridge/launcher-adds.ts `launcherItems`), so a list
 * that holds only the shell never arrives; a machine with no agent installed and no rows of its own
 * keeps the one-tap shell the "+" always made (M91 decision 4).
 */
export function hasSheetRows(rows: SheetRows): boolean {
  return rows.agents.some((r) => r.unavailable === null) || rows.commands.some((r) => r.unavailable === null);
}

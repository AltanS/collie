// A RETRY ON A CHECKOUT FINDS THE SPACE THAT ALREADY SHOWS IT (issue 732, ADR 0126 note of 2026-11-13).
//
// A create whose checkout already exists (`existed: true`, bridge/worktree-add.ts) is a retry: the
// half-done create whose open was refused, or the same request again after a lost answer. The open may
// have happened, and a plain `createSpace` on tmux, tuios, tern or the Herdr core has no memory of the
// folder, so asking again would put a second space on it. Herdr's `worktree.open` answers `already_open`,
// the others do not, and the rule belongs to no adapter. So the bridge looks first, in the multiplexer's
// current snapshot, for a space whose first pane stands in the checkout, and uses that.
//
// A space "shows" a folder when its FIRST pane's `cwd` is that folder, as real paths. A later pane that
// cd'd there, or a space whose first pane wandered elsewhere, does not count: the first pane is where
// the open put the shell, and a space made by hand in the folder is the same thing.

import { realpath } from "node:fs/promises";

import type { MuxAdapter, MuxCreatedPane, MuxPane } from "./mux/types.ts";

/** A space that already shows the checkout: its first pane, and whether a launcher may be typed there. */
export interface ReusedSpace {
  readonly pane: MuxCreatedPane;
  /**
   * The pane is a live, bare shell. Only then may the launcher's line be typed into it: a pane that
   * runs an agent, or one that has gone, is somebody's work and is left alone.
   */
  readonly fresh: boolean;
}

/** The real path of `path`, or the path as given when it cannot be resolved. */
async function realOrSame(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * The space that already shows `path`, or `null` when none does or the multiplexer cannot be read.
 *
 * Never throws: a snapshot that fails costs the reuse and nothing else, and the caller opens the
 * folder the ordinary way, which is what it did before this module existed.
 */
export async function spaceShowing(herdr: Pick<MuxAdapter, "snapshot">, path: string): Promise<ReusedSpace | null> {
  let panes: readonly MuxPane[];
  try {
    panes = (await herdr.snapshot()).panes;
  } catch {
    return null;
  }
  const wanted = await realOrSame(path);
  const seen = new Set<string>();
  for (const pane of panes) {
    // The first pane of each space, in the snapshot's order.
    if (seen.has(pane.spaceId)) continue;
    seen.add(pane.spaceId);
    if (pane.cwd === "" || (await realOrSame(pane.cwd)) !== wanted) continue;
    return {
      pane: { paneId: pane.paneId, spaceId: pane.spaceId, spaceLabel: pane.spaceLabel, tabId: pane.tabId, cwd: pane.cwd },
      fresh: pane.alive && pane.agent === "shell",
    };
  }
  return null;
}

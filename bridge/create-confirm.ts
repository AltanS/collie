// A CREATE THAT TIMED OUT IS NOT A CREATE THAT FAILED (M100 spec 04).
//
// A multiplexer's create call (`createSpace`, `createTab`) that does not answer in time may still have
// made the pane. The adapters say so with the contract's `unconfirmed` answer (bridge/mux/types.ts,
// "Sent, and not confirmed in time"), and a route that read it as a failure made a second pane on the
// retry. So the route looks: it reads the multiplexer's snapshot again and asks whether a pane stands
// there that was not there before the call. Found, the create worked and the route answers with that pane.
// Not found after the bound, the create did not happen and the answer is the plain failure. A snapshot
// that cannot be read, or that shows more than one new space or tab, proves nothing, and the route says the
// outcome is unknown.
//
// WHAT "NEW" MEANS. The ids the state engine held when the call began (`knownBefore`), read from memory
// and not from the multiplexer, so a create costs no extra round trip. A pane with an id outside both
// sets, in the space asked for (a tab) or in a space that was not known (a space), whose folder is the
// one asked for when one was, is the new one. The rule reads only the contract's own snapshot, so it holds
// for every multiplexer, and each adapter's part is the one thing only it knows: that its own call timed out.
//
// Same style as `bridge/worktree-reuse.ts`, which finds the space a retry already made.

import { realpath } from "node:fs/promises";

import type { MuxAdapter, MuxCreatedPane, MuxPane } from "./mux/types.ts";

/**
 * The longest a launch, a tab or a space create takes on the machine that runs it, from the first call
 * to its answer: the adapter's own wait for the create (5 s), the snapshot look after a time-out
 * ({@link CONFIRM_BOUND_MS}), the wait for the new shell to draw (5 s), and room for the typing and the
 * topology read. A lead that forwards one of these gives it this long, never less (bridge/crew/peer-client.ts),
 * and a launch receipt still pending after it is no longer pending (bridge/launch-receipts.ts).
 */
export const LAUNCH_BUDGET_MS = 18_000;

/** How long the look at the snapshot goes on before "not found" is the answer. */
export const CONFIRM_BOUND_MS = 4000;

/** The gap between two looks. */
export const CONFIRM_POLL_MS = 500;

/** The pane ids and space ids the state engine knew when a create began. */
export interface KnownBefore {
  readonly panes: ReadonlySet<string>;
  readonly spaces: ReadonlySet<string>;
}

/** What a create asked for: a tab in one space, or a space. `cwd` is the folder it named, when it named one. */
export type CreateWanted =
  | { readonly kind: "tab"; readonly spaceId: string; readonly cwd?: string | undefined }
  | { readonly kind: "space"; readonly cwd?: string | undefined };

/** What the look found. `none` is a snapshot that was read and shows nothing new; `unread` proves nothing. */
export type CreateLook = { readonly kind: "found"; readonly pane: MuxCreatedPane } | { readonly kind: "none" } | { readonly kind: "unread" };

/** The clock the look runs on, injected so a test drives it on a fake one. */
export interface LookClock {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/** What the state engine knows now, as the sets a later look compares against. */
export function knownBefore(current: {
  readonly agents: readonly { readonly paneId: string; readonly workspaceId: string }[];
  readonly shellPanes?: readonly { readonly paneId: string; readonly workspaceId: string }[] | undefined;
  readonly workspaces: readonly { readonly workspaceId: string }[];
}): KnownBefore {
  const panes = new Set<string>();
  const spaces = new Set<string>();
  for (const pane of [...current.agents, ...(current.shellPanes ?? [])]) {
    panes.add(pane.paneId);
    spaces.add(pane.workspaceId);
  }
  for (const space of current.workspaces) spaces.add(space.workspaceId);
  return { panes, spaces };
}

async function realOrSame(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** The one new space or tab a snapshot shows, as its first pane; `null` when none; `"many"` when it cannot tell which. */
async function newPaneIn(panes: readonly MuxPane[], known: KnownBefore, wanted: CreateWanted): Promise<MuxCreatedPane | null | "many"> {
  const folder = wanted.cwd === undefined || wanted.cwd === "" ? null : await realOrSame(wanted.cwd);
  const found = new Map<string, MuxPane>();
  for (const pane of panes) {
    if (known.panes.has(pane.paneId)) continue;
    if (wanted.kind === "tab" ? pane.spaceId !== wanted.spaceId : known.spaces.has(pane.spaceId)) continue;
    if (folder !== null && pane.cwd !== "" && (await realOrSame(pane.cwd)) !== folder) continue;
    // One entry per new tab (a tab) or per new space (a space): its first pane, in the snapshot's order.
    const unit = wanted.kind === "tab" ? pane.tabId : pane.spaceId;
    if (!found.has(unit)) found.set(unit, pane);
  }
  if (found.size === 0) return null;
  if (found.size > 1) return "many";
  const [pane] = [...found.values()];
  if (pane === undefined) return null;
  return { paneId: pane.paneId, spaceId: pane.spaceId, spaceLabel: pane.spaceLabel, tabId: pane.tabId, cwd: pane.cwd };
}

/**
 * Look for the pane a create that timed out may have made. Reads the snapshot again and again, up to
 * {@link CONFIRM_BOUND_MS}, and answers `none` only when its last look read the snapshot. It stops at the first look that finds it or cannot tell which of two new
 * ones is it. Never throws: a snapshot that fails is a look that proved nothing.
 */
export async function lookForCreated(
  mux: Pick<MuxAdapter, "snapshot">,
  known: KnownBefore,
  wanted: CreateWanted,
  clock: LookClock = {},
): Promise<CreateLook> {
  const sleep = clock.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = clock.now ?? (() => Date.now());
  const started = now();
  let read = false;
  for (;;) {
    try {
      const panes = (await mux.snapshot()).panes;
      read = true;
      const fresh = await newPaneIn(panes, known, wanted);
      if (fresh === "many") return { kind: "unread" };
      if (fresh !== null) return { kind: "found", pane: fresh };
    } catch {
      // A look that fails is a look that shows nothing; the next one may read.
      read = false;
    }
    if (now() - started >= CONFIRM_BOUND_MS) return read ? { kind: "none" } : { kind: "unread" };
    await sleep(CONFIRM_POLL_MS);
  }
}

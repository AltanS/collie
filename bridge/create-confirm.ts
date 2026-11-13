// A CREATE THAT TIMED OUT IS NOT A CREATE THAT FAILED (M100 spec 04).
//
// A multiplexer's create call (`createSpace`, `createTab`) that does not answer in time may still have
// made the pane. The adapters say so with the contract's `unconfirmed` answer (bridge/mux/types.ts,
// "Sent, and not confirmed in time"), and a route that read it as a failure made a second pane on the
// retry. So the route looks: it reads the multiplexer's snapshot again and asks whether a pane stands
// there that was not there before the call. Found, the create worked and the route answers with that pane.
// Not found after the bound proves nothing either: the bound is a time-out, and a create that landed at 5 s
// is a pane the look did not see. So the route answers unknown in every case the look does not find the pane
// (a snapshot that cannot be read, one with more than one candidate, or one with none), and keeps its receipt
// as `unknown`, so the same id never creates again. Only a create the multiplexer REFUSED, or one that never
// left the bridge, is a plain failure and forgets its id.
//
// WHAT "NEW" MEANS. The ids a FRESH snapshot held right before the call (`knownBefore`), read from the
// multiplexer and not from the state engine's memory, which may be a poll behind and would then name a pane
// somebody else made as ours. A pane with an id outside both sets, in the space asked for (a tab) or in a
// space that was not known (a space), is a candidate. It is the new one when its folder is the one asked for
// (a pane that reports no folder is NOT a match yet: the look goes on) and, when the request named a label
// and the snapshot carries the tab's or space's own, that label is the one asked for. A candidate that
// cannot be judged yet, whose label differs, or that is merely new when the request named no folder and no
// label to be told apart by, is doubtful: it is never named, and it keeps the look from saying "not made",
// because it may be ours under a name the multiplexer changed. The rule reads only the
// contract's own snapshot, so it holds for every multiplexer, and each adapter's part is the one thing only
// it knows: that its own call timed out.
//
// EVERY WAIT HAS A BOUND. The look as a whole stops at {@link CONFIRM_BOUND_MS}, and so does one snapshot
// that hangs inside it, which counts as a look that proved nothing. A route's whole run has one deadline too
// ({@link MEMBER_DEADLINE_MS}): past it the route answers unknown at once and the run goes on.
//
// Same style as `bridge/worktree-reuse.ts`, which finds the space a retry already made.

import { realpathSync } from "node:fs";

import type { MuxAdapter, MuxCreatedPane, MuxPane, MuxSnapshot } from "./mux/types.ts";

/**
 * The longest a launch, a tab or a space create takes on the lead's side, from the first call to its
 * answer. A lead that forwards one of these gives it this long, never less (bridge/crew/peer-client.ts), and
 * a launch receipt still pending after it is no longer pending (bridge/launch-receipts.ts). The member's own
 * run stops waiting at {@link MEMBER_DEADLINE_MS}, below this by the crew round trip and a margin.
 */
export const LAUNCH_BUDGET_MS = 18_000;

/**
 * The deadline of the member's whole run of one of these routes. Its steps add up to more than the lead
 * gives (the create's own wait 5 s, the look 4 s, the wait for the shell 5 s, a send on the core about
 * 6.4 s), so one deadline sits on the run: past it the route answers `write_outcome_unknown` and the run goes
 * on in the background, to settle its receipt as the pane or as unknown.
 */
export const MEMBER_DEADLINE_MS = 15_000;

/** How long the look at the snapshot goes on before "not found" is the answer. */
export const CONFIRM_BOUND_MS = 4000;

/** The gap between two looks. */
export const CONFIRM_POLL_MS = 500;

/** The pane ids and space ids a snapshot showed before a create began. */
export interface KnownBefore {
  readonly panes: ReadonlySet<string>;
  readonly spaces: ReadonlySet<string>;
}

/**
 * What a create asked for: a tab in one space, or a space. `cwd` is the folder it named and `label` the
 * name it gave, when it named them.
 */
export type CreateWanted =
  | { readonly kind: "tab"; readonly spaceId: string; readonly cwd?: string | undefined; readonly label?: string | undefined }
  | { readonly kind: "space"; readonly cwd?: string | undefined; readonly label?: string | undefined };

/**
 * What the look found. `found` carries the new pane and what the snapshot called its agent; `none` is a
 * snapshot that was read and shows nothing new; `unread` proves nothing.
 */
export type CreateLook =
  | { readonly kind: "found"; readonly pane: MuxCreatedPane; readonly agent: string }
  | { readonly kind: "none" }
  | { readonly kind: "unread" };

/** The clock the look runs on, injected so a test drives it on a fake one. */
export interface LookClock {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/** The ids a snapshot holds, as the sets a later look compares against. */
export function knownBefore(snapshot: Pick<MuxSnapshot, "panes" | "spaces">): KnownBefore {
  const panes = new Set<string>();
  const spaces = new Set<string>();
  for (const pane of snapshot.panes) {
    panes.add(pane.paneId);
    spaces.add(pane.spaceId);
  }
  for (const space of snapshot.spaces) spaces.add(space.spaceId);
  return { panes, spaces };
}

/** A timer that can be cancelled. On a fake clock the cancel does nothing and the fake owns the time. */
export interface CreateTimer {
  readonly fired: Promise<"timeout">;
  cancel(): void;
}

/** Start a timer of `ms` on `clock`: its own `sleep` when it has one, else the real one. */
export function startTimer(ms: number, clock: LookClock): CreateTimer {
  if (clock.sleep !== undefined) return { fired: clock.sleep(ms).then(() => "timeout" as const), cancel: () => {} };
  let handle: ReturnType<typeof setTimeout> | undefined;
  const fired = new Promise<"timeout">((resolve) => {
    handle = setTimeout(() => resolve("timeout"), ms);
  });
  return { fired, cancel: () => clearTimeout(handle) };
}

/** `run`'s value, or `"timeout"` when `ms` pass first. A `run` that rejects after the timeout is not an unhandled rejection. */
export async function withinTime<T>(run: Promise<T>, ms: number, clock: LookClock): Promise<T | "timeout"> {
  const timer = startTimer(ms, clock);
  try {
    return await Promise.race([run, timer.fired]);
  } finally {
    timer.cancel();
  }
}

// Synchronous on purpose: one `realpath` of a folder the route already checked, and a look whose steps all
// wait on the clock only, so a test on a fake clock is exact.
function realOrSame(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The new space or tab in one snapshot: its first pane and agent, or why there is none yet. */
type NewPane =
  | { readonly kind: "found"; readonly pane: MuxCreatedPane; readonly agent: string }
  | { readonly kind: "none" }
  /** A new pane stands where the request would put one, but it cannot be told to be ours yet. */
  | { readonly kind: "doubtful" }
  | { readonly kind: "many" };

/** The label the snapshot gives the unit a pane is in, or "" when it carries none. */
function labelOf(snapshot: MuxSnapshot, pane: MuxPane, wanted: CreateWanted): string {
  if (wanted.kind === "tab") return snapshot.tabs.find((tab) => tab.tabId === pane.tabId)?.label ?? "";
  return snapshot.spaces.find((space) => space.spaceId === pane.spaceId)?.label ?? pane.spaceLabel;
}

function newPaneIn(snapshot: MuxSnapshot, known: KnownBefore, wanted: CreateWanted): NewPane {
  const folder = wanted.cwd === undefined || wanted.cwd === "" ? null : realOrSame(wanted.cwd);
  const asked = wanted.label === undefined || wanted.label === "" ? null : wanted.label;
  const matched = new Map<string, MuxPane>();
  const doubtful = new Set<string>();
  for (const pane of snapshot.panes) {
    if (known.panes.has(pane.paneId)) continue;
    if (wanted.kind === "tab" ? pane.spaceId !== wanted.spaceId : known.spaces.has(pane.spaceId)) continue;
    // One entry per new tab (a tab) or per new space (a space): its first pane, in the snapshot's order.
    const unit = wanted.kind === "tab" ? pane.tabId : pane.spaceId;
    if (folder !== null) {
      // A pane that reports no folder yet is not a match yet: the next look may read it.
      if (pane.cwd === "") {
        doubtful.add(unit);
        continue;
      }
      if (realOrSame(pane.cwd) !== folder) continue;
    }
    const label = labelOf(snapshot, pane, wanted);
    if (asked !== null && label !== "" && label !== asked) {
      doubtful.add(unit);
      continue;
    }
    // "It is new" is not a property of THIS request: a person, or another device, may have opened that tab or
    // space in the same moment. A match needs one thing the request named, the folder or the label, and the
    // snapshot must show it. A create that named neither (the phone's "+" on a tab) adopts nothing.
    const named = folder !== null || (asked !== null && label === asked);
    if (!named) {
      doubtful.add(unit);
      continue;
    }
    if (!matched.has(unit)) matched.set(unit, pane);
  }
  for (const unit of matched.keys()) doubtful.delete(unit);
  if (matched.size === 0) return doubtful.size === 0 ? { kind: "none" } : { kind: "doubtful" };
  if (matched.size > 1 || doubtful.size > 0) return { kind: "many" };
  const [pane] = [...matched.values()];
  if (pane === undefined) return { kind: "none" };
  return { kind: "found", agent: pane.agent, pane: { paneId: pane.paneId, spaceId: pane.spaceId, spaceLabel: pane.spaceLabel, tabId: pane.tabId, cwd: pane.cwd } };
}

/**
 * The multiplexer's snapshot as a create's "before", read now, or `null` when it cannot be read in
 * {@link CONFIRM_BOUND_MS}. Never throws. A create run without it can be answered, but never looked up.
 */
export async function snapshotBefore(mux: Pick<MuxAdapter, "snapshot">, clock: LookClock = {}): Promise<KnownBefore | null> {
  try {
    const read = await withinTime(mux.snapshot(), CONFIRM_BOUND_MS, clock);
    return read === "timeout" ? null : knownBefore(read);
  } catch {
    return null;
  }
}

/**
 * Look for the pane a create that timed out may have made. Reads the snapshot again and again, up to
 * {@link CONFIRM_BOUND_MS}, and answers `none` only when its last look read the snapshot and saw no pane
 * that might be ours. A snapshot that hangs is raced against the time left and counts as unread. It stops at
 * the first look that finds the pane or cannot tell which of two new ones is it. Never throws.
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
  let verdict: "none" | "unread" = "unread";
  for (;;) {
    verdict = "unread";
    try {
      const left = Math.max(CONFIRM_BOUND_MS - (now() - started), 1);
      const read = await withinTime(mux.snapshot(), left, clock);
      if (read !== "timeout") {
        const fresh = newPaneIn(read, known, wanted);
        if (fresh.kind === "many") return { kind: "unread" };
        if (fresh.kind === "found") return fresh;
        // A new pane that cannot be told apart yet is not "nothing was made".
        verdict = fresh.kind === "none" ? "none" : "unread";
      }
    } catch {
      // A look that fails is a look that shows nothing; the next one may read.
    }
    if (now() - started >= CONFIRM_BOUND_MS) return { kind: verdict };
    await sleep(CONFIRM_POLL_MS);
  }
}

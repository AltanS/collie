// The registry of rounds, keyed by id. The workspace's design app reads it to build a round into a
// proposal (`design propose <worktree> <round id>`). A round's module has a default export, a
// `PickRoundDef` (./types.ts), and is loaded only when its page is opened. Add a round with one line
// here and one file under `rounds/`; delete both before the branch merges.
import type { PickRoundDef } from "./types";

export type PickRoundLoader = () => Promise<{ default: PickRoundDef }>;

const REGISTRY = {
  // Deliver now on the held mark: the operator's pick, kept for one more look at the timing.
  "walky-deliver-now": () => import("./rounds/walky-deliver-now"),
  // M97 spec 05: the four look decisions of the session filter. Waits for the operator's pick.
  "session-filter": () => import("./rounds/session-filter"),
} satisfies Record<string, PickRoundLoader>;

/** Every round, by id. */
export const ROUNDS: ReadonlyMap<string, PickRoundLoader> = new Map(Object.entries(REGISTRY));

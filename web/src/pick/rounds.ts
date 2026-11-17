// The registry of rounds, keyed by id. The workspace's design app reads it to build a round into a
// proposal (`design propose <worktree> <round id>`). A round's module has a default export, a
// `PickRoundDef` (./types.ts), and is loaded only when its page is opened. Add a round with one line
// here and one file under `rounds/`; delete both before the branch merges.
import type { PickRoundDef } from "./types";

export type PickRoundLoader = () => Promise<{ default: PickRoundDef }>;

const REGISTRY = {} satisfies Record<string, PickRoundLoader>;

/** Every round, by id. */
export const ROUNDS: ReadonlyMap<string, PickRoundLoader> = new Map(Object.entries(REGISTRY));

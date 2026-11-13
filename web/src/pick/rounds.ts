// The registry of rounds, keyed by id: one HTML entry (`pick.html`) serves any of them through
// `?round=<id>`. A round's module has a default export, a `PickRoundDef`, and is loaded only when its page
// is opened. Add a round with one line here and one file under `rounds/`.
import type { PickRoundDef } from "./pick-page";

export type PickRoundLoader = () => Promise<{ default: PickRoundDef }>;

const REGISTRY = {
  // M97 spec 05: the four look decisions of the session filter. Waits for the operator's pick.
  "session-filter": () => import("./rounds/session-filter"),
} satisfies Record<string, PickRoundLoader>;

/** Every round, by id. */
export const ROUNDS: ReadonlyMap<string, PickRoundLoader> = new Map(Object.entries(REGISTRY));

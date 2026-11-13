// The data path in the browser leg (M99 spec 13), opt-in with COLLIE_RIG_DATA=1. Pure: no side
// effects, Node builtins only, so the rig CLI (bun), the Playwright runner (node) and the tests import
// the same rules.
//
//   COLLIE_RIG_DATA unset or `0`   the leg as it was: every send, ask and WalkyTalky message is typed
//   COLLIE_RIG_DATA=1              each scratch bridge opens its inside socket (COLLIE_INSIDE=1), and
//                                  every rig Claude Code loads the Collie mod from this checkout
//                                  (`--plugin-dir <worktree>/inside/claude`) and finds its own
//                                  machine's bridge through that bridge's hook target folder
//
// The mod is loaded for the session only: nothing is linked, no `claude plugin` runs, and no folder of
// the operator's is read or written. pi and omp have no part yet and keep the screen path. A data run
// keeps its own cassettes, in `cassettes-data/` under the leg `<leg>-data`, because a prompt handed over
// by data reaches the model in another shape than a typed one; the default run's cassettes, in
// `cassettes/`, are never read or written (replay/tier.ts cassetteRoot).
import { join } from "node:path";

/** Whether this run has the data path on. Throws on a word that is neither on nor off. */
export function rigDataFrom(raw: string | undefined): boolean {
  const word = (raw ?? "").trim();
  if (word === "" || word === "0") return false;
  if (word === "1") return true;
  throw new Error(`COLLIE_RIG_DATA must be 1 or 0, not "${word}"`);
}

/** The data path of this process's run. */
export const RIG_DATA = rigDataFrom(process.env.COLLIE_RIG_DATA);

/** The cassette leg a run records and replays under: the leg itself, or `<leg>-data` with the data path on. */
export function cassetteLeg(leg: string, data: boolean = RIG_DATA): string {
  return data ? `${leg}-data` : leg;
}

/** What a bridge's environment gains with the data path on: the inside socket, with no link. */
export function dataBridgeEnv(data: boolean = RIG_DATA): Readonly<Record<string, string>> {
  return data ? { COLLIE_INSIDE: "1" } : { COLLIE_INSIDE: "0" };
}

/**
 * What a rig Claude Code gains with the data path on: the mod from this checkout, and the state home
 * whose hook target folder names its own machine's bridge (the bridge runs under `bridgeHome`).
 */
/** The extra arguments and variables of a rig Claude Code's start. */
export interface DataClaude {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export function dataClaude(worktree: string, bridgeHome: string, data: boolean = RIG_DATA): DataClaude {
  if (!data) return { argv: [], env: {} };
  return { argv: ["--plugin-dir", join(worktree, "inside", "claude")], env: { XDG_STATE_HOME: join(bridgeHome, ".local", "state") } };
}

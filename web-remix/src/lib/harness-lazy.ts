// The harness (web/src/lib/harness: every agent's grammar, about 120 KB) on demand (S3).
//
// An islands pane page draws its rows from the server's frames and its card from the poll answer's
// screen model (routes/pane/parse-model.ts), so nothing on its first screen needs a grammar. The
// composer asks the harness three small things (does the draft in the terminal carry our send, is it
// opaque, which key cancels), all of them after the operator acts or when the terminal holds a draft;
// a write goes through answer.ts, which needs the guards. So the harness loads on the first of those
// moments (`loadHarness`), and `harnessLoaded` wakes whoever asked.
//
// The static shell has the harness in its own chunk already (its parse imports it), and its boot hands
// the module over at once (`provideHarness`, spa-boot.tsx): there `adapterFor` answers from the first
// render, exactly as the direct import did.
import type * as Harness from "@web/lib/harness";

import { createStore } from "./store";

type HarnessModule = typeof Harness;
type Adapter = ReturnType<HarnessModule["adapterFor"]>;

let loaded: HarnessModule | null = null;
let loading: Promise<HarnessModule> | null = null;

/** True once the harness module is here. Subscribe to re-render with it. */
export const harnessLoaded = createStore(false);

/** Hand over a module already loaded (the static shell's boot). */
export function provideHarness(mod: HarnessModule): void {
  loaded = mod;
  loading = Promise.resolve(mod);
  harnessLoaded.set(true);
}

/** Load the harness once; every later call gets the same promise. */
export function loadHarness(): Promise<HarnessModule> {
  loading ??= import("@web/lib/harness").then((mod) => {
    loaded = mod;
    harnessLoaded.set(true);
    return mod;
  });
  return loading;
}

/** The agent's adapter, or undefined: no adapter, or the harness is not here yet. */
export function adapterFor(agent: string | undefined): Adapter {
  return loaded?.adapterFor(agent);
}

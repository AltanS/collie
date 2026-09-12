// pi's cache rules — the same four provider rules opencode ships, under the `pi.` prefix.
//
// pi (and Oh My Pi, which reports itself as `omp` and resolves through `AGENT_ALIASES`) is
// provider-agnostic in exactly opencode's way: a session names its own provider and model, and the
// cache lifetime belongs to that upstream. There is no `omp.ts` and there must not be one — `omp` is
// an alias of `pi` in `bridge/journal/registry.ts:76`, and its cache rules resolve through the same
// alias, exactly as its transcript does.
//
// cache-alert has no pi adapter, so there is nothing to copy here beyond the provider numbers it
// already published; those are in `providers.ts` with their sources and dates intact.

import type { CacheRule } from "../claims.ts";
import { providerRules } from "./providers.ts";

export const PI_RULES: readonly CacheRule[] = providerRules("pi");

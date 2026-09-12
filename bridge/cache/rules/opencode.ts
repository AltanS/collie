// opencode's cache rules — one per upstream provider, all under tier `api`.
//
// opencode is provider-agnostic: every session records its own `providerID`, and the cache lifetime
// is the upstream's rather than opencode's. So a per-tier number would be wrong for most sessions,
// which is why the four rules are built from `providers.ts` and picked per session by the model the
// probe read.
//
// The values are copied VERBATIM from AltanS/herdr-cache-alert `src/harness/opencode.ts:85-143`, read
// 2026-09-12; they live in `providers.ts` so `pi.ts` shares them rather than restating them.

import type { CacheRule } from "../claims.ts";
import { providerRules } from "./providers.ts";

export const OPENCODE_RULES: readonly CacheRule[] = providerRules("opencode");

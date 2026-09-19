// opencode's cache rules — one per upstream provider, all under tier `api`.
//
// opencode is provider-agnostic: every session records its own `providerID`, and the cache lifetime
// is the upstream's rather than opencode's. So a per-tier number would be wrong for most sessions,
// which is why the four rules are built from `providers.ts` and picked per session by the model the
// probe read.
//
// The values are copied VERBATIM from AltanS/herdr-cache-alert `src/harness/opencode.ts:85-143`, read
// 2026-09-12; they live in `providers.ts` so `pi.ts` shares them rather than restating them.

import type { CacheRule, ResetRule } from "../claims.ts";
import { providerRules } from "./providers.ts";

export const OPENCODE_RULES: readonly CacheRule[] = providerRules("opencode");

// ── Actions that drop the cache between turns ───────────────────────────────
//
// Copied from AltanS/herdr-cache-alert `src/harness/opencode.ts` (commit 17fb2af). opencode documents
// no cache rules of its own, so both are INFERRED from Anthropic's statement about its own cache, and
// the counts are that commit's, from one machine's `opencode.db` across Google, Moonshot and xAI
// upstreams: thin samples, and the notes say so. Detection reads structured fields only, never message
// text (`bridge/journal/opencode.ts` § opencodeResets).

const ANTHROPIC_CACHING = {
  url: "https://code.claude.com/docs/en/prompt-caching",
  title: "How Claude Code uses prompt caching",
  publisher: "Anthropic",
  retrievedAt: "2026-09-17",
  kind: "vendor-doc",
} as const;

const OPENCODE_INFERRED =
  "opencode documents no cache rules of its own, and most of its upstreams publish none for this action. Inferred from Anthropic's statement about its own cache";

export const OPENCODE_RESET_RULES: readonly ResetRule[] = [
  {
    id: "opencode.reset.model",
    harness: "opencode",
    label: "The model or provider changed",
    // opencode writes nothing when a model is picked. The choice lands on the next user message, which
    // is also when the turn starts, so it is seen with the turn and not before it.
    detection: "after-turn",
    resets: {
      value: true,
      confidence: "inferred",
      source: { ...ANTHROPIC_CACHING, quote: "Each model has its own cache." },
      note: `${OPENCODE_INFERRED}. 3 of 3 model changes were followed by a cold or near-cold turn.`,
    },
  },
  {
    id: "opencode.reset.compaction",
    harness: "opencode",
    label: "The session was compacted",
    detection: "before-turn",
    resets: {
      value: true,
      confidence: "inferred",
      source: {
        ...ANTHROPIC_CACHING,
        quote:
          "By design, this invalidates the conversation layer, since the next request has a new, shorter history that doesn't share a prefix with the old one.",
      },
      note: `${OPENCODE_INFERRED}'s compaction, which replaces history with a summary as opencode's does. 1 of 1 compaction was cold, a single sample.`,
    },
  },
];

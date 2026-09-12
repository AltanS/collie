// Claude Code's cache rules.
//
// Copied VERBATIM from AltanS/herdr-cache-alert `src/harness/claude.ts:25-108`, read 2026-09-12 —
// every value, url, title, publisher, quote and `retrievedAt`. What did NOT come across is that
// file's `ttlOverride()` and `detectTier()`: both read `process.env`, and the bridge is a
// `systemd --user` unit whose environment belongs to the wrong process (ADR 0041).
//
// Claude is the one harness that needs no guess anyway. The same assistant entry that gives
// `lastRequestAt` also carries `cache_creation.ephemeral_1h_input_tokens`, so the first reading is
// already measured — see `bridge/journal/claude.ts` § cacheProbe.

import type { CacheRule, Source, Sourced } from "../claims.ts";

const CACHING_DOC = {
  url: "https://code.claude.com/docs/en/prompt-caching",
  title: "How Claude Code uses prompt caching",
  publisher: "Anthropic",
  retrievedAt: "2026-08-24",
  kind: "vendor-doc",
} as const satisfies Source;

const API_DOC = {
  url: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
  title: "Prompt caching, Claude Platform Docs",
  publisher: "Anthropic",
  retrievedAt: "2026-08-24",
  kind: "vendor-doc",
} as const satisfies Source;

const SLIDING: Source = {
  ...CACHING_DOC,
  quote:
    "Cached prefixes expire after a period of inactivity. Each request that hits the cache resets the timer, so the cache stays warm as long as you keep working.",
};

/** 3600 s, and it is the one rule an operator file is most likely to move. */
const SUBSCRIPTION_TTL: Sourced<number> = {
  value: 3600,
  confidence: "documented",
  source: {
    ...CACHING_DOC,
    quote:
      "On a Claude subscription, Claude Code requests the one-hour TTL automatically, so the cache survives breaks of up to an hour.",
  },
};

const API_TTL: Sourced<number> = {
  value: 300,
  confidence: "documented",
  source: {
    ...CACHING_DOC,
    quote:
      "On an API key, Amazon Bedrock, Google Cloud's Agent Platform, Microsoft Foundry, or Claude Platform on AWS, you pay the per-token rates, so the TTL stays at the cheaper five minutes by default.",
  },
};

export const CLAUDE_RULES: readonly CacheRule[] = [
  {
    id: "claude.subscription",
    harness: "claude",
    tier: "subscription",
    label: "Claude Code on a Claude subscription (Pro/Max)",
    ttlSeconds: SUBSCRIPTION_TTL,
    slidingWindow: true,
    automatic: true,
    sources: [SLIDING],
    notes: [
      "Drops to the five-minute TTL once you are over the plan limit and drawing on usage credits, because a 1h cache write costs more. ENABLE_PROMPT_CACHING_1H=1 keeps the hour.",
      "Subagents use the five-minute TTL even on a subscription — the automatic hour applies to the main conversation only.",
      "The cache is scoped to one machine AND one directory: two sessions in different directories never share it.",
    ],
  },
  {
    id: "claude.api",
    harness: "claude",
    tier: "api",
    label: "Claude Code on an API key or third-party provider",
    ttlSeconds: API_TTL,
    minTokens: {
      value: 1024,
      confidence: "documented",
      note: "Model-dependent — 1024 for Sonnet-class models, 512 for the Opus/Fable class. The lower bound is used here.",
      source: {
        ...API_DOC,
        quote: "Shorter prompts cannot be cached, even if marked with `cache_control`.",
      },
    },
    slidingWindow: true,
    automatic: true,
    sources: [SLIDING, { ...CACHING_DOC, quote: "To opt into the one-hour TTL, set `ENABLE_PROMPT_CACHING_1H=1`." }],
    notes: [
      "ENABLE_PROMPT_CACHING_1H=1 buys the hour here too, at a higher cache-write rate.",
      "On Amazon Bedrock, caching support and 1h availability vary by model — zero cache tokens usually means the model does not support it.",
    ],
  },
];

/**
 * The rule for a Claude pane at a given tier.
 *
 * An unknown tier takes `claude.api`, which is the SHORTER of the two. When unsure, be pessimistic: a
 * wrong early warning costs a glance, a wrong "still warm" sends the operator back to a cache that
 * expired fifty minutes ago.
 */
export function claudeRuleFor(tier: string | undefined): CacheRule | undefined {
  return tier === "subscription" ? CLAUDE_RULES[0] : CLAUDE_RULES[1];
}

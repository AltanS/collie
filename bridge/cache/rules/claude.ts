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

import type { CacheRule, ResetRule, Source, Sourced } from "../claims.ts";

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

// ── Actions that drop the cache between turns ───────────────────────────────
//
// Copied from AltanS/herdr-cache-alert `src/harness/claude-resets.ts` (commit 17fb2af), every quote
// and its `retrievedAt`, and the quotes re-read against the live page on 2026-09-19. The labels are
// Collie's own, because the pane sheet slots them into a sentence. The counts in each `note` come from
// that commit: 160 Claude Code transcripts, main chain only, each case a turn less than 50 minutes after
// the one before, so an expired one-hour TTL cannot explain the miss.
//
// Detection lives beside the transcript it reads, in `bridge/journal/claude-resets.ts`.

const RESETS_DOC = { ...CACHING_DOC, retrievedAt: "2026-09-17" } as const satisfies Source;

export const CLAUDE_RESET_RULES: readonly ResetRule[] = [
  {
    id: "claude.reset.model",
    harness: "claude",
    label: "The model changed",
    detection: "before-turn",
    resets: {
      value: true,
      confidence: "documented",
      source: {
        ...RESETS_DOC,
        quote:
          "Each model has its own cache. Switching with `/model` means the next request reads the entire conversation history with no cache hits, even though the content is identical.",
      },
      note: "28 of 28 `/model` switches to a different model were followed by a cold turn. A `/model` that keeps the model keeps the cache, so only a DIFFERENT model counts. A model change with no command behind it (a fallback, a skill that names its own model) is seen on the turns themselves, so it explains a cold turn but cannot warn before one. A name that does not reduce to a known family and version (a family newer than this build, or \"Default (recommended)\") is read as no switch at all, so a `/model` onto a brand-new family warns nothing and the observed cold mark catches the miss one turn later.",
    },
  },
  {
    id: "claude.reset.effort",
    harness: "claude",
    label: "The effort level changed",
    detection: "before-turn",
    resets: {
      value: true,
      confidence: "documented",
      source: {
        ...RESETS_DOC,
        quote:
          "On most models, changing the effort level mid-session means the next request reads the entire conversation history with no cache hits.",
      },
      note: "Not on Fable 5.1 from Claude Code 2.1.260: \"Before v2.1.260, changing effort on Fable 5.1 with an API key or a Claude subscription also invalidated the cache.\" 10 of 11 `/effort` changes were cold. Two gaps: a `/model` that keeps the model but changes effort is not detected, because nothing on disk records the effort it replaced; and Fable 5.1 on Bedrock, Agent Platform or a gateway still resets, which Collie cannot see because it does not read the agent's environment (ADR 0041).",
    },
  },
  {
    id: "claude.reset.compaction",
    harness: "claude",
    label: "The conversation was compacted",
    detection: "before-turn",
    resets: {
      value: true,
      confidence: "documented",
      source: {
        ...RESETS_DOC,
        quote:
          "By design, this invalidates the conversation layer, since the next request has a new, shorter history that doesn't share a prefix with the old one.",
      },
      note: "123 of 123 compactions were followed by a cold turn. The system prompt layer survives, so the rebuild is the summary, not the whole context. A compaction whose summary pushes the boundary record out of the probe's 128 KB tail is not seen until the next turn.",
    },
  },
  {
    id: "claude.reset.reload-plugins-force",
    harness: "claude",
    label: "Plugins were reloaded with --force",
    detection: "before-turn",
    resets: {
      value: true,
      confidence: "documented",
      source: {
        ...RESETS_DOC,
        quote:
          "When `/reload-plugins` runs and the reload would trigger a full re-read, Claude Code shows a warning and doesn't apply the reload. Run `/reload-plugins --force` to apply it anyway.",
      },
      note: "Pessimistic: `--force` only rebuilds when the reload changes tools in the prefix, and nothing on disk says whether it did.",
    },
  },
  {
    id: "claude.reset.reload-plugins",
    harness: "claude",
    label: "Plugins were reloaded without --force",
    detection: "before-turn",
    resets: {
      value: false,
      confidence: "documented",
      source: {
        ...RESETS_DOC,
        quote:
          "Claude Code never invalidates the cache for a plugin's skills, commands, agents, hooks, monitors, or themes.",
      },
      note: "A plain reload that WOULD re-read everything is refused with a warning, so it keeps the cache either way. 3 of 3 plain reloads stayed warm.",
    },
  },
];

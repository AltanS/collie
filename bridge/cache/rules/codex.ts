// Codex CLI's cache rules.
//
// Copied VERBATIM from AltanS/herdr-cache-alert `src/harness/codex.ts:44-150`, read 2026-09-12. The
// numbers themselves live in `providers.ts` because they are OpenAI's, not Codex's — this file says
// which provider Codex talks to and carries the Codex-specific gap.
//
// Both tiers carry the LEGACY number deliberately. These rules are the fallback for when the model is
// not known: an early poll, a tail with no `turn_context` in it. Be pessimistic there, and let
// `modelRuleFor` raise it to 30 minutes once a turn names a GPT-5.6-or-later model.

import type { CacheRule, ResetRule, Source } from "../claims.ts";
import { OPENAI_AUTOMATIC_SOURCE, OPENAI_MIN_TOKENS, OPENAI_REGIMES } from "./providers.ts";

/**
 * The Codex-specific hole, kept as a claim so the sheet can show it.
 *
 * This page proves prompt caching APPLIES on a ChatGPT plan — it meters "Cached input tokens" as its
 * own rate-card column. What it does NOT state is a lifetime. No OpenAI page does, for Codex on a
 * plan.
 */
const CODEX_PLAN_DOC: Source = {
  url: "https://learn.chatgpt.com/docs/pricing",
  title: "Pricing, ChatGPT",
  publisher: "OpenAI",
  retrievedAt: "2026-08-24",
  kind: "vendor-doc",
  quote: "Usage is calculated in credits per million input tokens, cached input tokens, and output tokens.",
};

export const CODEX_RULES: readonly CacheRule[] = [
  {
    id: "codex.subscription",
    harness: "codex",
    tier: "subscription",
    label: "Codex CLI signed in with a ChatGPT plan",
    ttlSeconds: { ...OPENAI_REGIMES.legacy },
    minTokens: { ...OPENAI_MIN_TOKENS },
    slidingWindow: true,
    automatic: true,
    sources: [OPENAI_AUTOMATIC_SOURCE, CODEX_PLAN_DOC],
    notes: [
      "GAP: OpenAI publishes no cache TTL for Codex on a ChatGPT plan. The pricing page proves caching applies and is billed at a tenth of the input rate, but names no lifetime. These are the general API figures applied to Codex's request shape.",
      "This is the FALLBACK figure, used only until a turn reveals the model. The number painted on a live session comes from the model rule.",
    ],
  },
  {
    id: "codex.api",
    harness: "codex",
    tier: "api",
    label: "Codex CLI on an OpenAI API key",
    ttlSeconds: { ...OPENAI_REGIMES.legacy },
    minTokens: { ...OPENAI_MIN_TOKENS },
    slidingWindow: true,
    automatic: true,
    sources: [OPENAI_AUTOMATIC_SOURCE],
    notes: [
      "The shorter of OpenAI's two regimes, used until the model is known. GPT-5.6 and later get 30 minutes instead.",
      "A cache miss follows any change to the prefix, which for Codex includes the model, the tool set, and the working directory.",
    ],
  },
];

/** The rule for a Codex pane at a given tier. Unknown takes `codex.api`; both carry the same TTL. */
export function codexRuleFor(tier: string | undefined): CacheRule | undefined {
  return tier === "subscription" ? CODEX_RULES[0] : CODEX_RULES[1];
}

/**
 * The Codex reset rules are a GAP, shipped as one so the catalog shows it.
 *
 * Carried over from AltanS/herdr-cache-alert `src/harness/codex.ts` (commit 17fb2af). Nothing here is
 * detected, and the note says why in terms of what was actually looked at.
 */
export const CODEX_RESET_RULES: readonly ResetRule[] = [
  {
    id: "codex.reset.model",
    harness: "codex",
    label: "The model changed",
    detection: "none",
    resets: {
      value: true,
      confidence: "inferred",
      source: {
        url: "https://code.claude.com/docs/en/prompt-caching",
        title: "How Claude Code uses prompt caching",
        publisher: "Anthropic",
        retrievedAt: "2026-09-17",
        kind: "vendor-doc",
        quote: "Each model has its own cache.",
      },
      note: "OpenAI publishes no model-switch rule for Codex; inferred from Anthropic's. NOT DETECTED: the Codex rollouts checked write one `turn_context` per session and no record for a switch between turns, so there is nothing to compare, and the chip cannot warn about one.",
    },
  },
];

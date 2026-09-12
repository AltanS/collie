// One rule per PROVIDER, and the harness files say which provider they are talking to.
//
// cache-alert already did this by hand: `OPENAI_REGIMES` is exported from its codex file and imported
// by its opencode file. Collie makes it explicit, because two harnesses here fan out across the same
// set of upstreams — opencode and pi both pick their provider per session — and the same OpenAI
// number written twice is the same OpenAI number that goes stale once.
//
// Every value, source, quote and `retrievedAt` below is copied VERBATIM from
// AltanS/herdr-cache-alert, read 2026-09-12:
//   `src/harness/codex.ts:29-91`   OPENAI_CACHE_DOC, OPENAI_REGIMES, MIN_TOKENS, AUTOMATIC_SOURCE
//   `src/harness/codex.ts:101-109` openaiCacheRegime
//   `src/harness/opencode.ts:36-143` ANTHROPIC_DOC, OR_DOC, ANTHROPIC_TTL, GOOGLE_TTL, UNKNOWN_TTL
//   `src/harness/opencode.ts:196-208` upstreamOf, RULE_BY_UPSTREAM
// The `retrievedAt` of `2026-08-24` is kept unchanged on purpose. Re-dating a claim to the port date
// would be a lie about when somebody last read the page, and the staleness clocks read that field.

import type { CacheRule, Source, Sourced } from "../claims.ts";

export const OPENAI_CACHE_DOC = {
  url: "https://developers.openai.com/api/docs/guides/prompt-caching",
  title: "Prompt caching | OpenAI API",
  publisher: "OpenAI",
  retrievedAt: "2026-08-24",
  kind: "vendor-doc",
} as const satisfies Source;

export const ANTHROPIC_DOC = {
  url: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
  title: "Prompt caching, Claude Platform Docs",
  publisher: "Anthropic",
  retrievedAt: "2026-08-24",
  kind: "vendor-doc",
} as const satisfies Source;

export const OR_DOC = {
  url: "https://openrouter.ai/docs/features/prompt-caching",
  title: "Prompt Caching, OpenRouter",
  publisher: "OpenRouter",
  retrievedAt: "2026-08-24",
  kind: "vendor-doc",
} as const satisfies Source;

/**
 * OpenAI runs TWO cache regimes at once, split by model generation, and one operator has both in
 * their logs. A per-tier number is therefore wrong for one of them whichever value it takes, which is
 * why {@link openaiCacheRegime} exists and why these sit apart from the tier rules.
 */
export const OPENAI_REGIMES = {
  modern: {
    value: 1800,
    confidence: "documented",
    note: "GPT-5.6 and later. `prompt_cache_options.ttl` accepts only `30m`, which is also the default, so this is the whole range rather than a typical case.",
    source: {
      ...OPENAI_CACHE_DOC,
      quote: "The 30-minute lifetime begins when the prefix is written and refreshes whenever the prefix is reused.",
    },
  },
  legacy: {
    value: 300,
    confidence: "documented",
    note: "Models before GPT-5.6. The documented range is 5-10 minutes idle with an hour as the ceiling; the LOW end is used, so the warning arrives early rather than late. Some models support opt-in extended retention of up to 24 hours — Codex is not known to request it, so it is not assumed here.",
    source: {
      ...OPENAI_CACHE_DOC,
      quote:
        "When using the in-memory policy, cached prefixes generally remain active for 5 to 10 minutes of inactivity, up to a maximum of one hour.",
    },
  },
} as const satisfies Record<string, Sourced<number>>;

export const OPENAI_MIN_TOKENS: Sourced<number> = {
  value: 1024,
  confidence: "documented",
  source: {
    ...OPENAI_CACHE_DOC,
    quote: "By default, caching is enabled automatically for prompts that are 1,024 tokens or longer.",
  },
};

export const OPENAI_AUTOMATIC_SOURCE: Source = {
  ...OPENAI_CACHE_DOC,
  quote: "By default, caching is enabled automatically for prompts that are 1,024 tokens or longer.",
};

export const ANTHROPIC_TTL: Sourced<number> = {
  value: 300,
  confidence: "documented",
  note: 'Extendable to an hour by the CALLER sending `"ttl": "1h"`. opencode is not known to, so the default is assumed. Anthropic also measures the lifetime from the START of the request, not the end of the response — a long streamed answer eats into it, so this countdown is very slightly generous.',
  source: { ...ANTHROPIC_DOC, quote: "By default, the cache has a 5-minute lifetime." },
};

export const GOOGLE_TTL: Sourced<number> = {
  value: 180,
  confidence: "reported",
  note: "GAP: Google publishes no TTL for implicit caching. This is OpenRouter's restatement of upstream behaviour, and it gives a RANGE — the low end is used, so the warning arrives early rather than late.",
  source: { ...OR_DOC, quote: "Note that the TTL is on average 3-5 minutes, but will vary" },
};

/**
 * The pessimistic default, for an upstream that publishes nothing — xAI is the live example: its docs
 * describe caching as automatic and say entries "can be evicted due to memory pressure", but state no
 * lifetime at all. Five minutes is the shortest rule any upstream documents.
 */
export const UNKNOWN_TTL: Sourced<number> = {
  value: 300,
  confidence: "inferred",
  note: "GAP: this upstream publishes no cache TTL. Five minutes is the shortest lifetime any documented provider uses, assumed here so the chip is early rather than late. It is NOT a number this provider has confirmed.",
  source: { ...OR_DOC, quote: "Note that the TTL is on average 3-5 minutes, but will vary" },
};

const XAI_DOC: Source = {
  url: "https://docs.x.ai/developers/advanced-api-usage/prompt-caching",
  title: "Prompt caching, xAI",
  publisher: "xAI",
  retrievedAt: "2026-08-24",
  kind: "vendor-doc",
  quote: "Cache entries can be evicted due to memory pressure, and requests may be routed to different servers.",
};

/**
 * Which cache regime a model name falls under.
 *
 * The doc splits on "GPT-5.6 and later", so the split is read off the version in the name. `null`
 * means the name did not parse — an unknown model must NOT be guessed into a regime, because guessing
 * "modern" doubles the countdown on a cache that is already gone.
 */
export function openaiCacheRegime(model: string): keyof typeof OPENAI_REGIMES | null {
  const match = /gpt-(\d+)\.(\d+)/i.exec(model);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  if (major > 5) return "modern";
  return major === 5 && minor >= 6 ? "modern" : "legacy";
}

/**
 * The upstream behind a session, given `providerID` and `modelID`.
 *
 * OpenRouter is a gateway, so `providerID` is `openrouter` for everything and the REAL upstream is the
 * vendor prefix on the model id (`openai/gpt-5.6-sol`, `x-ai/grok-4.6`).
 */
export function upstreamOf(providerId: string, modelId: string): string {
  const provider = providerId.toLowerCase();
  if (provider !== "openrouter") return provider;
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash).toLowerCase() : provider;
}

/**
 * The provider key each upstream name resolves to. Anything absent takes `unknown`, which is the
 * pessimistic five minutes.
 *
 * The first four rows are cache-alert's `RULE_BY_UPSTREAM` (`src/harness/opencode.ts:203-208`). The
 * fifth is pi's: pi spells an OpenAI-through-Codex session `openai-codex`, observed on real logs on
 * 2026-09-13. A row here is an IDENTITY claim ("this name means that vendor"), never a TTL claim, so it
 * needs no source of its own — the number it lands on carries one.
 */
const PROVIDER_BY_UPSTREAM: ReadonlyMap<string, ProviderKey> = new Map([
  ["anthropic", "anthropic"],
  ["openai", "openai"],
  ["google", "google"],
  ["google-vertex", "google"],
  ["openai-codex", "openai"],
]);

/** The four providers a provider-fanning harness can be talking to. */
export type ProviderKey = "anthropic" | "openai" | "google" | "unknown";

/** The upstream name mapped onto a provider key, or `unknown` for one nobody documents. */
export function providerKeyFor(upstream: string): ProviderKey {
  return PROVIDER_BY_UPSTREAM.get(upstream.toLowerCase()) ?? "unknown";
}

/**
 * The four rules a provider-fanning harness ships, under its own id prefix.
 *
 * opencode and pi are both provider-agnostic: every session records its own provider, and the TTL is
 * the upstream's rather than the harness's. So the rules are the same four facts under two prefixes,
 * built here once so the numbers cannot drift between them.
 */
export function providerRules(harness: string): CacheRule[] {
  return [
    {
      id: `${harness}.anthropic`,
      harness,
      tier: "api",
      label: `${harness} → Anthropic`,
      ttlSeconds: { ...ANTHROPIC_TTL },
      slidingWindow: true,
      automatic: false,
      sources: [
        { ...ANTHROPIC_DOC, quote: "The cache is refreshed for no additional cost each time the cached content is used." },
      ],
      notes: ["Anthropic needs explicit cache_control breakpoints — a client that sends none gets no cache at all."],
    },
    {
      id: `${harness}.openai`,
      harness,
      tier: "api",
      label: `${harness} → OpenAI`,
      ttlSeconds: { ...OPENAI_REGIMES.legacy },
      slidingWindow: true,
      automatic: true,
      sources: [OPENAI_REGIMES.legacy.source, OPENAI_REGIMES.modern.source],
      notes: [
        "OpenAI runs two regimes split by model generation. This rule carries the shorter one; a session whose model parses as GPT-5.6 or later gets 30 minutes instead.",
      ],
    },
    {
      id: `${harness}.google`,
      harness,
      tier: "api",
      label: `${harness} → Google`,
      ttlSeconds: { ...GOOGLE_TTL },
      slidingWindow: false,
      automatic: true,
      sources: [{ ...OR_DOC, quote: "Note that the TTL is on average 3-5 minutes, but will vary" }],
      notes: ["Google's implicit cache is best-effort: a hit is never guaranteed, whatever the clock says."],
    },
    {
      id: `${harness}.unknown`,
      harness,
      tier: "api",
      label: `${harness} → an upstream that documents no TTL`,
      ttlSeconds: { ...UNKNOWN_TTL },
      slidingWindow: false,
      automatic: true,
      sources: [XAI_DOC],
      notes: [
        "GAP: xAI (and several smaller upstreams) document that caching happens but never how long it lasts. The countdown here is an assumption, not a claim — the warm/cold verdict from the harness's own token counts is the trustworthy part of this chip.",
      ],
    },
  ];
}

/**
 * The TTL for the model a provider-fanning session is really on, given `providerID:modelID`.
 *
 * An OpenAI upstream is split again by model generation, because OpenAI's own lifetime depends on it.
 * An unrecognised OpenAI name takes the shorter regime rather than no rule at all: the upstream IS
 * known here, and only the generation is in doubt.
 */
export function providerModelTtl(model: string): Sourced<number> | undefined {
  const colon = model.indexOf(":");
  if (colon < 0) return undefined;
  const providerId = model.slice(0, colon);
  const modelId = model.slice(colon + 1);
  const upstream = upstreamOf(providerId, modelId);

  const key = providerKeyFor(upstream);
  if (key === "openai") {
    // The vendor prefix is not part of the model name OpenAI documents, so strip it before asking
    // which regime the name falls under. An unrecognised name takes the SHORTER regime rather than no
    // rule at all: the upstream IS known to be OpenAI here, and only the generation is in doubt.
    const bare = modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;
    const chosen = openaiCacheRegime(bare) === "modern" ? OPENAI_REGIMES.modern : OPENAI_REGIMES.legacy;
    return { ...chosen, note: `${bare}: ${chosen.note}` };
  }
  if (key === "anthropic") return { ...ANTHROPIC_TTL, note: `${upstream}: ${ANTHROPIC_TTL.note ?? ""}`.trim() };
  if (key === "google") return { ...GOOGLE_TTL, note: `${upstream}: ${GOOGLE_TTL.note ?? ""}`.trim() };
  return { ...UNKNOWN_TTL, note: `${upstream} publishes no cache TTL. ${UNKNOWN_TTL.note ?? ""}`.trim() };
}

/** The provider rule id a `providerID:modelID` string resolves to, under `harness`. */
export function providerRuleIdFor(harness: string, model: string | undefined): string {
  if (model === undefined || model === "") return `${harness}.unknown`;
  const colon = model.indexOf(":");
  if (colon < 0) return `${harness}.unknown`;
  const upstream = upstreamOf(model.slice(0, colon), model.slice(colon + 1));
  return `${harness}.${providerKeyFor(upstream)}`;
}

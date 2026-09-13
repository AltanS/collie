// The rule catalog — the single decision site for "which cache rule does this pane run on".
//
// One file per journal adapter that ships a rule, plus `providers.ts` for the numbers two of them
// share. There is no `omp.ts`: `omp` is an alias of `pi` (`bridge/journal/registry.ts:76`), and its
// rules resolve through the same alias its transcript does. There is no `grok.ts` and no `hermes.ts`
// either: neither vendor publishes a TTL Collie could quote, and inventing one is exactly what the
// sourced-claim rule exists to prevent. Those panes read `unknown`, which renders as nothing.

import { AGENT_ALIASES } from "../../journal/registry.ts";
import type { CacheRule, Sourced } from "../claims.ts";
import type { CacheProbe } from "../engine.ts";
import { claudeRuleFor, CLAUDE_RULES } from "./claude.ts";
import { codexRuleFor, CODEX_RULES } from "./codex.ts";
import { OPENCODE_RULES } from "./opencode.ts";
import { PI_RULES } from "./pi.ts";
import { openaiCacheRegime, OPENAI_REGIMES, providerModelTtl, providerRuleIdFor } from "./providers.ts";

/** The alias map as a Map, asked the same way `adapterFor` asks it — see registry.ts for why. */
const ALIAS_LOOKUP: ReadonlyMap<string, string> = new Map(Object.entries(AGENT_ALIASES));

/** Harness names whose rules are picked by the session's PROVIDER rather than by a payment tier. */
const PROVIDER_FANNING: ReadonlySet<string> = new Set(["opencode", "pi"]);

/** Every shipped rule, in a stable order. The order is the catalog's; nothing may sort it in place. */
export function allCacheRules(): readonly CacheRule[] {
  return ALL;
}

const ALL: readonly CacheRule[] = [...CLAUDE_RULES, ...CODEX_RULES, ...PI_RULES, ...OPENCODE_RULES];

const BY_ID: ReadonlyMap<string, CacheRule> = new Map(ALL.map((rule) => [rule.id, rule]));

export function cacheRuleById(id: string): CacheRule | undefined {
  return BY_ID.get(id);
}

/** The canonical harness name — `omp` resolves to `pi`, as everywhere else. */
export function canonicalHarness(harness: string): string {
  return ALIAS_LOOKUP.get(harness) ?? harness;
}

/**
 * The rule a probe's pane runs on, or undefined when the harness ships none.
 *
 * Undefined is the honest answer for grok and hermes, and the engine turns it into `unknown`, which
 * renders as nothing. A pane whose harness fans out across providers but whose probe named no model
 * takes the `.unknown` rule — the shortest of the four.
 */
export function ruleForProbe(harness: string, probe: CacheProbe | undefined): CacheRule | undefined {
  const name = canonicalHarness(harness);
  return measuredRule(name, probe) ?? ruleByTier(name, probe);
}

/** The tier or provider guess — what the catalog says before the transcript is allowed a vote. */
function ruleByTier(name: string, probe: CacheProbe | undefined): CacheRule | undefined {
  if (name === "claude") return claudeRuleFor(probe?.tier);
  if (name === "codex") return codexRuleFor(probe?.tier);
  if (PROVIDER_FANNING.has(name)) return cacheRuleById(providerRuleIdFor(name, probe?.model));
  return undefined;
}

/**
 * The rule a MEASURED TTL identifies on its own, when exactly one of the harness's rules carries it.
 *
 * The chip's number comes from the transcript (precedence rung 1), but the rule id is what the sheet
 * cites a page and a date from — so the two must agree. A Claude pane on a Max subscription names no
 * tier anywhere in its log, so `claudeRuleFor(undefined)` takes the pessimistic `claude.api`, and a
 * measured 3600 s was then shown beside the five-minute API page. The measurement already answers the
 * question the tier guess was guessing at: one hour is the subscription rule and nothing else.
 *
 * Deliberately narrow. Two rules sharing a TTL (codex's two both fall back to 300 s) identify nothing,
 * so the guess stands; a measurement matching no rule leaves the guess alone as well, because an
 * unrecognised number is not evidence about which page to quote.
 */
function measuredRule(name: string, probe: CacheProbe | undefined): CacheRule | undefined {
  const measured = probe?.observedTtlSeconds?.value;
  if (measured === undefined) return undefined;
  const matches = ALL.filter((rule) => rule.harness === name && rule.ttlSeconds.value === measured);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The TTL for the MODEL this session is really on, where the harness's vendor splits on it.
 *
 * Today that is only OpenAI's generation split: one Codex operator has both `gpt-5.1-codex` (5-10
 * minutes) and `gpt-5.6-sol` (30 minutes) in their logs, so a per-tier number is wrong for one of
 * them. It sits below the operator override and above the tier rule — it is still a documented rule,
 * only aimed at what the session is actually doing.
 */
export function modelRuleFor(harness: string, model: string | undefined): Sourced<number> | undefined {
  if (model === undefined || model === "") return undefined;
  const name = canonicalHarness(harness);
  if (name === "codex") {
    const regime = openaiCacheRegime(model);
    if (regime === null) return undefined;
    const rule = OPENAI_REGIMES[regime];
    return { ...rule, note: `${model}: ${rule.note}` };
  }
  if (PROVIDER_FANNING.has(name)) return providerModelTtl(model);
  return undefined;
}

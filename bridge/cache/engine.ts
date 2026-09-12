// pane → cache state. The one place the numbers are decided, and it is PURE.
//
// No wall clock, no fs, no import from an adapter, no React. `now` arrives as a parameter and the
// next memo is RETURNED rather than mutated, so the whole precedence table is testable as data.
//
// Two rules govern everything here, both carried over from AltanS/herdr-cache-alert `src/engine.ts`:
//
//   MEASURED BEATS DOCUMENTED. If the harness's own transcript says the session wrote to a one-hour
//   cache, that is the TTL. No documented rule and no operator file outvotes it.
//
//   WHEN UNSURE, BE PESSIMISTIC. An unknown tier takes the harness's SHORTEST rule. A wrong early
//   warning costs a glance; a wrong "still warm" sends the operator back to a cache that expired ten
//   minutes ago.
//
// And one rule this port adds (ADR 0041, Decision 1): NOTHING IS SHOWN BEFORE IT IS MEASURED.
// cache-alert can guess before the first turn because it reads the agent's own environment; the
// bridge cannot, so it does not guess. {@link evaluate} returns `undefined` when neither the probe
// nor the memo supplies a `lastRequestAt`, and a pane with no entry carries no `cache` key at all.

import type { CacheRule, Confidence, Sourced, Tier } from "./claims.ts";

export type CacheStateName = "warm" | "expiring" | "cold" | "unknown";

/** One reading of a harness's transcript. Produced by `JournalAdapter.cacheProbe`. */
export interface CacheProbe {
  /** Epoch ms of the last outbound request. The clock every countdown runs from. */
  lastRequestAt: number;
  /** Stable id of the turn this reading came from — what keeps a cold turn judged once. */
  turnId: string;
  /** Tokens READ from cache on that turn. Undefined means "no telemetry", which is not a zero. */
  cacheReadTokens?: number;
  /** Tokens WRITTEN to cache on that turn. */
  cacheCreationTokens?: number;
  /** A TTL the transcript itself stated. Outranks every rule and every override. */
  observedTtlSeconds?: Sourced<number>;
  /** The model, in whatever shape the harness writes it (`providerID:modelID` where it fans out). */
  model?: string;
  /** Subscription or API key, where the transcript says so. */
  tier?: Tier;
  /** When the evidence was read — a file mtime or a row's own timestamp. Display only. */
  measuredAt?: number;
  /** One line naming what was read, for a doctor line and a log. Never transcript content. */
  evidence: string;
}

/** What the tracker remembers about one session between polls. In memory only. */
export interface CacheMemo {
  lastTurnId: string;
  lastRequestAt: number;
  lastColdAt: number;
  /** 0 when nothing has ever been measured for this session. */
  observedTtlSeconds: number;
  measuredAt?: number;
}

/** One row of the operator's `cache-rules.toml`, after validation. */
export interface CacheOverride {
  ruleId: string;
  ttlSeconds: number;
  sourceUrl: string;
  retrieved: string;
  note?: string;
}

/** What rides on a pane. Seven small fields; the source and the date are fetched once by the sheet. */
export interface PaneCache {
  state: CacheStateName;
  /** Epoch ms the cache dies. Absent only in the `unknown` state, which is never stored. */
  expiresAt?: number;
  ttlSeconds: number;
  ruleId: string;
  confidence: Confidence;
  lastRequestAt?: number;
  measuredAt?: number;
  /** Present, and always `true`, when the number came from `cache-rules.toml`. */
  overridden?: true;
}

/**
 * The warn threshold, as a fraction of the TTL rather than a flat number.
 *
 * A flat 300 s against a 5-minute TTL would mark every pane "expiring" from the moment it was born,
 * which is how a warning becomes wallpaper.
 */
export function warnSecondsFor(ttlSeconds: number): number {
  return Math.max(60, Math.round(ttlSeconds * 0.25));
}

/** A turn that read nothing from cache while writing to it MISSED. No telemetry is not cold. */
export function isColdTurn(probe: CacheProbe): boolean {
  if (probe.cacheReadTokens === undefined) return false;
  return probe.cacheReadTokens === 0 && (probe.cacheCreationTokens ?? 0) > 0;
}

/** The sticky cold mark first, then the clock, then the warn shoulder. One expression, named. */
function coldOrClock(lastColdAt: number, secondsLeft: number, ttlSeconds: number): CacheStateName {
  if (lastColdAt > 0 || secondsLeft <= 0) return "cold";
  return secondsLeft <= warnSecondsFor(ttlSeconds) ? "expiring" : "warm";
}

/** Everything {@link evaluate} is allowed to look at. */
export interface EvaluateInput {
  rule?: CacheRule;
  probe?: CacheProbe;
  memo?: CacheMemo;
  override?: CacheOverride;
  /** A TTL for the model this session is really on — below the override, above the rule. */
  modelTtl?: Sourced<number>;
  now: number;
}

/**
 * Fold the precedence, the expiry and the sticky cold mark into one pane reading.
 *
 * PRECEDENCE (ADR 0041): measured now, then measured earlier in this session, then the operator
 * override, then the model rule, then the tier or provider rule, then nothing.
 *
 * The "measured earlier" rung matters: a poll between turns has no probe to read, and dropping back to
 * the documented rule there would make the chip flip between 1h and 5m depending on how recently the
 * agent replied.
 *
 * Rung 3 is the operator file rather than cache-alert's `ENABLE_PROMPT_CACHING_1H`. The bridge cannot
 * read the agent's environment, and the file is the honest replacement: the same operator saying the
 * same thing in a place the bridge can read.
 *
 * Returns `undefined` when nothing has been measured — no probe and no memo with a `lastRequestAt` —
 * which is Decision 1 expressed as a type. Nothing to measure means nothing to say.
 */
export function evaluate(
  input: EvaluateInput,
): { cache: PaneCache; memo: CacheMemo } | undefined {
  const { rule, probe, memo, override, now } = input;

  // Rung 2: a TTL this session measured on an earlier turn. Minted as `observed` so it can never go
  // stale — it is re-measured on the next turn that writes cache tokens.
  const remembered: Sourced<number> | undefined =
    memo && memo.observedTtlSeconds > 0
      ? {
          value: memo.observedTtlSeconds,
          confidence: "observed",
          source: {
            url: "",
            title: "remembered from an earlier turn of this session",
            publisher: "local telemetry",
            retrievedAt: "",
            kind: "observed",
          },
        }
      : undefined;

  const overrideTtl: Sourced<number> | undefined =
    override === undefined
      ? undefined
      : {
          value: override.ttlSeconds,
          confidence: "reported",
          note: override.note ?? "set in cache-rules.toml",
          source: {
            url: override.sourceUrl,
            title: "cache-rules.toml",
            publisher: "operator",
            retrievedAt: override.retrieved,
            kind: "community",
          },
        };

  const ttl = probe?.observedTtlSeconds ?? remembered ?? overrideTtl ?? input.modelTtl ?? rule?.ttlSeconds;

  // A probe is the best clock. Without one, fall back to whatever the last probe left behind — never
  // to `now`, which would paint a warm chip on a pane idle since yesterday.
  const lastRequestAt = probe?.lastRequestAt ?? memo?.lastRequestAt ?? 0;
  if (ttl === undefined || lastRequestAt === 0) return undefined;

  // A NEW turn re-judges the cold mark: cold sets it, warm clears it. An unchanged turn id leaves the
  // mark alone, so one cold turn is judged once however many times it is polled.
  let lastColdAt = memo?.lastColdAt ?? 0;
  if (probe && probe.turnId !== memo?.lastTurnId && probe.cacheReadTokens !== undefined) {
    lastColdAt = isColdTurn(probe) ? probe.lastRequestAt : 0;
  }

  const measuredAt = probe?.measuredAt ?? memo?.measuredAt;
  const nextMemo: CacheMemo = {
    lastTurnId: probe?.turnId ?? memo?.lastTurnId ?? "",
    lastRequestAt,
    lastColdAt,
    observedTtlSeconds: probe?.observedTtlSeconds?.value ?? memo?.observedTtlSeconds ?? 0,
  };
  if (measuredAt !== undefined) nextMemo.measuredAt = measuredAt;

  const expiresAt = lastRequestAt + ttl.value * 1000;
  const secondsLeft = Math.round((expiresAt - now) / 1000);

  // The observed cold mark is STICKY: it survives until a warm turn clears it, because the operator
  // needs to see the miss they already paid for even if they were looking elsewhere when it happened.
  const state: CacheStateName = coldOrClock(lastColdAt, secondsLeft, ttl.value);

  const cache: PaneCache = {
    state,
    expiresAt,
    ttlSeconds: ttl.value,
    ruleId: rule?.id ?? "",
    confidence: ttl.confidence,
    lastRequestAt,
  };
  if (measuredAt !== undefined) cache.measuredAt = measuredAt;
  if (ttl === overrideTtl) cache.overridden = true;
  return { cache, memo: nextMemo };
}

import { describe, expect, test } from "bun:test";

import type { CacheRule, ResetEvent, ResetRule, Sourced } from "./claims.ts";
import {
  evaluate,
  isColdTurn,
  warnSecondsFor,
  type CacheMemo,
  type CacheOverride,
  type CacheProbe,
} from "./engine.ts";

// `evaluate` is the whole decision, and it is pure: `now` is a parameter, the next memo is returned
// rather than written, and nothing here touches a disk or a clock. So the precedence table, the three
// live states and the sticky cold mark are all data.

const NOW = 1_800_000_000_000;

const sourced = (value: number, confidence: Sourced<number>["confidence"] = "documented"): Sourced<number> => ({
  value,
  confidence,
  source: {
    url: "https://example.invalid/doc",
    title: "A doc",
    publisher: "Example",
    retrievedAt: "2026-08-24",
    kind: "vendor-doc",
    quote: "a sentence",
  },
});

const rule = (id: string, ttl: number): CacheRule => ({
  id,
  harness: id.split(".")[0] ?? id,
  tier: "api",
  label: id,
  ttlSeconds: sourced(ttl),
  slidingWindow: true,
  automatic: true,
  sources: [],
});

const probe = (over: Partial<CacheProbe> = {}): CacheProbe => ({
  lastRequestAt: NOW - 60_000,
  turnId: "turn-1",
  evidence: "a transcript",
  ...over,
});

describe("warnSecondsFor", () => {
  test("is a quarter of the TTL, with a floor of a minute", () => {
    expect(warnSecondsFor(3600)).toBe(900);
    expect(warnSecondsFor(1800)).toBe(450);
    // A flat 300 s against a 5-minute window would mark every pane expiring from birth.
    expect(warnSecondsFor(300)).toBe(75);
    expect(warnSecondsFor(180)).toBe(60);
    expect(warnSecondsFor(60)).toBe(60);
  });
});

describe("isColdTurn", () => {
  test("no telemetry is not cold", () => {
    expect(isColdTurn(probe())).toBe(false);
    expect(isColdTurn(probe({ cacheCreationTokens: 5000 }))).toBe(false);
  });
  test("a turn that read nothing while writing something MISSED", () => {
    expect(isColdTurn(probe({ cacheReadTokens: 0, cacheCreationTokens: 5000 }))).toBe(true);
  });
  test("a turn that read from cache is warm, whatever it wrote", () => {
    expect(isColdTurn(probe({ cacheReadTokens: 9000, cacheCreationTokens: 5000 }))).toBe(false);
  });
  test("a turn that wrote nothing is not a miss — it is a turn with no cache in it", () => {
    expect(isColdTurn(probe({ cacheReadTokens: 0, cacheCreationTokens: 0 }))).toBe(false);
  });
});

describe("nothing is shown before it is measured", () => {
  test("no probe and no memo yields undefined, however good the rule is", () => {
    expect(evaluate({ rule: rule("claude.api", 300), now: NOW })).toBeUndefined();
  });

  test("a memo with a lastRequestAt is enough on its own — a poll between turns still counts", () => {
    const memo: CacheMemo = { lastTurnId: "turn-1", lastRequestAt: NOW - 60_000, lastColdAt: 0, observedTtlSeconds: 0 };
    expect(evaluate({ rule: rule("claude.api", 300), memo, now: NOW })?.cache.state).toBe("warm");
  });

  test("a rule with no probe and a memo that never measured anything still yields undefined", () => {
    const memo: CacheMemo = { lastTurnId: "", lastRequestAt: 0, lastColdAt: 0, observedTtlSeconds: 0 };
    expect(evaluate({ rule: rule("claude.api", 300), memo, now: NOW })).toBeUndefined();
  });

  test("a probe with no rule at all still answers, because the probe measured the TTL itself", () => {
    const measured = evaluate({ probe: probe({ observedTtlSeconds: sourced(3600, "observed") }), now: NOW });
    expect(measured?.cache.ttlSeconds).toBe(3600);
    expect(measured?.cache.ruleId).toBe("");
  });
});

describe("the precedence order", () => {
  const claude = rule("claude.api", 300);
  const override: CacheOverride = {
    ruleId: "claude.api",
    ttlSeconds: 600,
    sourceUrl: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
    retrieved: "2026-09-12",
  };
  const memo: CacheMemo = { lastTurnId: "turn-0", lastRequestAt: NOW - 60_000, lastColdAt: 0, observedTtlSeconds: 1200 };
  const modelTtl = sourced(1800);

  test("1. a TTL the transcript measured NOW beats everything", () => {
    const out = evaluate({
      rule: claude,
      probe: probe({ observedTtlSeconds: sourced(3600, "observed") }),
      memo,
      override,
      modelTtl,
      now: NOW,
    });
    expect(out?.cache.ttlSeconds).toBe(3600);
    expect(out?.cache.confidence).toBe("observed");
    expect(out?.cache.overridden).toBeUndefined();
  });

  test("2. a TTL measured EARLIER in this session beats the override", () => {
    const out = evaluate({ rule: claude, probe: probe(), memo, override, modelTtl, now: NOW });
    expect(out?.cache.ttlSeconds).toBe(1200);
    expect(out?.cache.confidence).toBe("observed");
  });

  test("3. the operator override beats the model rule", () => {
    const out = evaluate({ rule: claude, probe: probe(), override, modelTtl, now: NOW });
    expect(out?.cache.ttlSeconds).toBe(600);
    expect(out?.cache.overridden).toBe(true);
  });

  test("4. the model rule beats the tier rule", () => {
    const out = evaluate({ rule: claude, probe: probe(), modelTtl, now: NOW });
    expect(out?.cache.ttlSeconds).toBe(1800);
    expect(out?.cache.overridden).toBeUndefined();
  });

  test("5. the tier rule is the floor", () => {
    const out = evaluate({ rule: claude, probe: probe(), now: NOW });
    expect(out?.cache.ttlSeconds).toBe(300);
    expect(out?.cache.ruleId).toBe("claude.api");
  });

  test("6. nothing at all yields undefined, not a guess", () => {
    expect(evaluate({ probe: probe(), now: NOW })).toBeUndefined();
  });
});

describe("the four states", () => {
  const claude = rule("claude.subscription", 3600);

  test("warm while more than a quarter of the window is left", () => {
    const out = evaluate({ rule: claude, probe: probe({ lastRequestAt: NOW - 600_000 }), now: NOW });
    expect(out?.cache.state).toBe("warm");
    expect(out?.cache.expiresAt).toBe(NOW - 600_000 + 3_600_000);
  });

  test("expiring inside the last quarter", () => {
    // 3600 s TTL, warn at 900 s: 2800 s elapsed leaves 800 s.
    const out = evaluate({ rule: claude, probe: probe({ lastRequestAt: NOW - 2_800_000 }), now: NOW });
    expect(out?.cache.state).toBe("expiring");
  });

  test("cold once the clock has run out", () => {
    const out = evaluate({ rule: claude, probe: probe({ lastRequestAt: NOW - 4_000_000 }), now: NOW });
    expect(out?.cache.state).toBe("cold");
  });

  test("cold the moment a turn comes back having missed, however much clock is left", () => {
    const out = evaluate({
      rule: claude,
      probe: probe({ lastRequestAt: NOW - 1000, cacheReadTokens: 0, cacheCreationTokens: 9000 }),
      now: NOW,
    });
    expect(out?.cache.state).toBe("cold");
  });
});

describe("the sticky cold mark", () => {
  const claude = rule("claude.subscription", 3600);
  const cold = probe({ lastRequestAt: NOW - 1000, turnId: "turn-9", cacheReadTokens: 0, cacheCreationTokens: 9000 });

  test("survives a poll that brings no new turn", () => {
    const first = evaluate({ rule: claude, probe: cold, now: NOW });
    expect(first?.cache.state).toBe("cold");
    expect(first?.memo.lastColdAt).toBe(NOW - 1000);
    // Same turn id, polled again: the mark is not re-judged, and it is not cleared either.
    const again = evaluate({ rule: claude, probe: cold, memo: first?.memo, now: NOW + 5000 });
    expect(again?.cache.state).toBe("cold");
  });

  test("is cleared by a NEW turn that read from cache", () => {
    const first = evaluate({ rule: claude, probe: cold, now: NOW });
    const warm = probe({ lastRequestAt: NOW, turnId: "turn-10", cacheReadTokens: 40_000, cacheCreationTokens: 100 });
    const next = evaluate({ rule: claude, probe: warm, memo: first?.memo, now: NOW + 1000 });
    expect(next?.cache.state).toBe("warm");
    expect(next?.memo.lastColdAt).toBe(0);
  });

  test("is left alone by a new turn that carries no telemetry", () => {
    const first = evaluate({ rule: claude, probe: cold, now: NOW });
    const blind = probe({ lastRequestAt: NOW, turnId: "turn-11" });
    const next = evaluate({ rule: claude, probe: blind, memo: first?.memo, now: NOW + 1000 });
    expect(next?.cache.state).toBe("cold");
  });
});

describe("measuredAt", () => {
  const claude = rule("claude.api", 300);

  test("rides through from the probe and never changes the state", () => {
    const at = NOW - 30_000;
    const out = evaluate({ rule: claude, probe: probe({ measuredAt: at }), now: NOW });
    expect(out?.cache.measuredAt).toBe(at);
    expect(out?.cache.state).toBe("warm");
    expect(out?.memo.measuredAt).toBe(at);
  });

  test("falls back to the memo's when a poll brought no probe", () => {
    const memo: CacheMemo = {
      lastTurnId: "turn-1",
      lastRequestAt: NOW - 60_000,
      lastColdAt: 0,
      observedTtlSeconds: 0,
      measuredAt: NOW - 90_000,
    };
    expect(evaluate({ rule: claude, memo, now: NOW })?.cache.measuredAt).toBe(NOW - 90_000);
  });

  test("is simply absent when nothing has been read", () => {
    const out = evaluate({ rule: claude, probe: probe(), now: NOW });
    expect("measuredAt" in (out?.cache ?? {})).toBe(false);
  });
});

test("the returned memo is new — evaluate mutates nothing it was handed", () => {
  const memo: CacheMemo = { lastTurnId: "turn-1", lastRequestAt: NOW - 60_000, lastColdAt: 0, observedTtlSeconds: 0 };
  const frozen = { ...memo };
  const out = evaluate({
    rule: rule("claude.api", 300),
    probe: probe({ turnId: "turn-2", lastRequestAt: NOW, observedTtlSeconds: sourced(3600, "observed") }),
    memo,
    now: NOW,
  });
  expect(memo).toEqual(frozen);
  expect(out?.memo.observedTtlSeconds).toBe(3600);
  expect(out?.memo.lastTurnId).toBe("turn-2");
});

// ── actions that drop the cache between turns (issue #236) ──────────────────
//
// The chip used to count down over a `/model` switch, and the next turn was billed as a full rebuild.
// Each case names the misreading it prevents.

describe("reset events", () => {
  const claude = rule("claude.subscription", 3600);
  const claim = (value: boolean): Sourced<boolean> => ({ ...sourced(0), value });
  const RESETS: ResetRule = {
    id: "claude.reset.model",
    harness: "claude",
    label: "The model changed",
    detection: "before-turn",
    resets: claim(true),
  };
  const KEEPS: ResetRule = { ...RESETS, id: "claude.reset.reload-plugins", label: "Plugins were reloaded", resets: claim(false) };
  const resetRules = [RESETS, KEEPS];
  const turnAt = NOW - 60_000;
  const event = (ruleId: string, at: number): ResetEvent => ({ ruleId, at, evidence: "a transcript" });

  test("an action after the last turn turns a warm pane cold, with time still on the clock", () => {
    const out = evaluate({ rule: claude, probe: probe({ lastRequestAt: turnAt, resets: [event(RESETS.id, turnAt + 1000)] }), resetRules, now: NOW });
    expect(out?.cache.state).toBe("cold");
    expect(out?.cache.coldReason).toBe("reset");
    expect(out?.cache.reset).toEqual({ ruleId: RESETS.id, label: "The model changed", at: turnAt + 1000 });
    // The clock still runs, which is exactly why the reason needs saying.
    expect((out?.cache.expiresAt ?? 0) > NOW).toBe(true);
  });

  test("puts nothing in the memo: the next turn clears the reset by being newer than it", () => {
    const first = evaluate({ rule: claude, probe: probe({ lastRequestAt: turnAt, resets: [event(RESETS.id, turnAt + 1000)] }), resetRules, now: NOW });
    expect(first?.memo).toEqual({ lastTurnId: "turn-1", lastRequestAt: turnAt, lastColdAt: 0, observedTtlSeconds: 0 });
    const next = probe({ lastRequestAt: NOW, turnId: "turn-2", cacheReadTokens: 9000, cacheCreationTokens: 10, resets: [event(RESETS.id, turnAt + 1000)] });
    const after = evaluate({ rule: claude, probe: next, memo: first?.memo, resetRules, now: NOW + 1000 });
    expect(after?.cache.state).toBe("warm");
    expect(after?.cache.coldReason).toBeUndefined();
    expect(after?.cache.reset).toBeUndefined();
  });

  test("a poll with no probe reads the held events, so a pending reset stays pending", () => {
    const memo: CacheMemo = { lastTurnId: "turn-1", lastRequestAt: turnAt, lastColdAt: 0, observedTtlSeconds: 0 };
    const out = evaluate({ rule: claude, memo, resetRules, heldResets: [event(RESETS.id, turnAt + 1000)], now: NOW });
    expect(out?.cache.coldReason).toBe("reset");
  });

  test("a probe's own list wins over a held one, even an empty one", () => {
    const out = evaluate({ rule: claude, probe: probe({ lastRequestAt: turnAt }), resetRules, heldResets: [event(RESETS.id, turnAt + 1000)], now: NOW });
    expect(out?.cache.state).toBe("warm");
  });

  test("an action BEFORE the last turn is history, not a warning: that turn already rebuilt", () => {
    const out = evaluate({ rule: claude, probe: probe({ lastRequestAt: turnAt, cacheReadTokens: 9000, cacheCreationTokens: 10, resets: [event(RESETS.id, turnAt - 1000)] }), resetRules, now: NOW });
    expect(out?.cache.state).toBe("warm");
    expect(out?.cache.reset).toBeUndefined();
  });

  test("a documented NON-reset never changes the state", () => {
    const out = evaluate({ rule: claude, probe: probe({ lastRequestAt: turnAt, resets: [event(KEEPS.id, turnAt + 1000)] }), resetRules, now: NOW });
    expect(out?.cache.state).toBe("warm");
  });

  test("an event naming a rule the harness does not ship is dropped, because it has no source", () => {
    const out = evaluate({ rule: claude, probe: probe({ lastRequestAt: turnAt, resets: [event("claude.reset.invented", turnAt + 1000)] }), resetRules, now: NOW });
    expect(out?.cache.state).toBe("warm");
  });

  test("with no reset rules handed in, every event is unsourced and nothing changes", () => {
    const out = evaluate({ rule: claude, probe: probe({ lastRequestAt: turnAt, resets: [event(RESETS.id, turnAt + 1000)] }), now: NOW });
    expect(out?.cache.state).toBe("warm");
  });

  test("an expired clock outranks a pending reset, so a cache that timed out is not blamed on the action", () => {
    const old = NOW - 4_000_000;
    const out = evaluate({ rule: claude, probe: probe({ lastRequestAt: old, resets: [event(RESETS.id, old + 1000)] }), resetRules, now: NOW });
    expect(out?.cache.coldReason).toBe("expired");
    expect(out?.cache.reset).toBeUndefined();
  });

  test("the observed cold mark outranks a pending reset", () => {
    const cold = probe({ lastRequestAt: turnAt, cacheReadTokens: 0, cacheCreationTokens: 9000, resets: [event(RESETS.id, turnAt + 1000)] });
    const out = evaluate({ rule: claude, probe: cold, resetRules, now: NOW });
    expect(out?.cache.coldReason).toBe("observed");
    expect(out?.cache.reset).toBeUndefined();
  });

  test("a cold turn after an action names that action as its cause", () => {
    const cold = probe({ lastRequestAt: turnAt, cacheReadTokens: 0, cacheCreationTokens: 9000, resets: [event(RESETS.id, turnAt - 1000)] });
    const out = evaluate({ rule: claude, probe: cold, resetRules, now: NOW });
    expect(out?.cache.coldReason).toBe("observed");
    expect(out?.cache.reset?.ruleId).toBe(RESETS.id);
  });

  test("a cold mark left from an OLDER turn names no cause from this turn's window", () => {
    const cold = probe({ lastRequestAt: turnAt - 5000, turnId: "turn-9", cacheReadTokens: 0, cacheCreationTokens: 9000 });
    const first = evaluate({ rule: claude, probe: cold, resetRules, now: NOW });
    // A newer turn with no telemetry leaves the mark standing; the action before it did not cause it.
    const blind = probe({ lastRequestAt: turnAt, turnId: "turn-10", resets: [event(RESETS.id, turnAt - 1000)] });
    const out = evaluate({ rule: claude, probe: blind, memo: first?.memo, resetRules, now: NOW });
    expect(out?.cache.coldReason).toBe("observed");
    expect(out?.cache.reset).toBeUndefined();
  });

  test("a warm or expiring reading carries no cold reason at all", () => {
    const out = evaluate({ rule: claude, probe: probe({ lastRequestAt: turnAt }), resetRules, now: NOW });
    expect("coldReason" in (out?.cache ?? {})).toBe(false);
    expect("reset" in (out?.cache ?? {})).toBe(false);
  });
});

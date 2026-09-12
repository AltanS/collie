import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  claimAgeDays,
  claimSources,
  newestReleaseDate,
  observedClaim,
  staleClaims,
  type CacheRule,
  type Source,
} from "./claims.ts";
import { allCacheRules } from "./rules/index.ts";

// The claim contract is the whole value of this feature: the numbers can be trusted because each one
// carries where it came from and when it was checked. Ported from herdr-cache-alert's
// `test/claims.test.ts`, plus the year gate this port adds.
//
// THIS FILE NEVER READS THE WALL CLOCK. Every date below is a literal, and the year gate's "now" is
// the newest numbered heading in this repo's own CHANGELOG. So a checkout of a tag passes or fails
// exactly as it did the day the tag was cut, forever — which is what makes a bisect and the VM lab
// safe. `collie doctor`'s 180-day warning is the one that reads the live clock, because doctor is a
// live check of a live machine.

const AT = new Date("2026-08-24T12:00:00Z");

const source = (over: Partial<Source> = {}): Source => ({
  url: "https://example.invalid/doc",
  title: "A doc",
  publisher: "Example",
  retrievedAt: "2026-08-01",
  kind: "vendor-doc",
  ...over,
});

const rule = (over: Partial<CacheRule> = {}): CacheRule => ({
  id: "x.subscription",
  harness: "x",
  tier: "subscription",
  label: "X",
  ttlSeconds: { value: 300, confidence: "documented", source: source() },
  slidingWindow: true,
  automatic: true,
  sources: [],
  ...over,
});

describe("the claim primitives", () => {
  test("claimAgeDays is Infinity for a date that cannot be read, so it always reads as stale", () => {
    expect(claimAgeDays(source({ retrievedAt: "2026-08-24" }), AT)).toBe(0);
    expect(claimAgeDays(source({ retrievedAt: "2026-08-01" }), AT)).toBe(23);
    expect(claimAgeDays(source({ retrievedAt: "last tuesday" }), AT)).toBe(Infinity);
    expect(claimAgeDays(source({ retrievedAt: "" }), AT)).toBe(Infinity);
  });

  test("staleClaims flags a claim past the threshold, and not one exactly on it", () => {
    const r = rule({
      ttlSeconds: { value: 300, confidence: "documented", source: source({ retrievedAt: "2026-08-01" }) },
    });
    expect(staleClaims([r], 23, AT)).toHaveLength(0);
    expect(staleClaims([r], 22, AT)).toHaveLength(1);
    expect(staleClaims([r], 22, AT)[0]?.field).toBe("ttlSeconds");
  });

  test("an OBSERVED claim never goes stale — it is re-measured on every probe", () => {
    const r = rule({ ttlSeconds: observedClaim(3600, "measured here", new Date("2020-01-01")) });
    expect(staleClaims([r], 1, AT)).toEqual([]);
  });

  test("staleClaims reaches minTokens and every extra source, not just the TTL", () => {
    const old = source({ retrievedAt: "2020-01-01" });
    const r = rule({
      ttlSeconds: { value: 300, confidence: "documented", source: old },
      minTokens: { value: 1024, confidence: "documented", source: old },
      sources: [old, old],
    });
    const fields = staleClaims([r], 30, AT).map((s) => s.field);
    expect(fields.toSorted()).toEqual(["minTokens", "sources[0]", "sources[1]", "ttlSeconds"]);
  });

  test("observedClaim stamps a real date and never carries a URL it did not read", () => {
    const o = observedClaim(3600, "cache_creation.ephemeral_1h_input_tokens > 0", AT);
    expect(o.confidence).toBe("observed");
    expect(o.source.retrievedAt).toBe("2026-08-24");
    expect(o.source.url).toBe("");
    expect(o.source.kind).toBe("observed");
  });
});

// ── the contract, applied to what actually ships ─────────────────────────────

describe("every shipped rule", () => {
  test("has a stable, harness-scoped id, and no two collide", () => {
    const ids = allCacheRules().map((r) => r.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of allCacheRules()) {
      // Scoped by harness, but the SECOND half is not always the tier: opencode and pi follow the
      // upstream PROVIDER, which differs per session. `cache-rules.toml` names these ids, so whatever
      // they are they must not move.
      expect(r.id.startsWith(`${r.harness}.`)).toBe(true);
      expect(r.id.length).toBeGreaterThan(r.harness.length + 1);
    }
  });

  test("carries a real ISO date on every claim, because the staleness clocks run on it", () => {
    for (const r of allCacheRules()) {
      for (const [field, s] of claimSources(r)) {
        expect(s.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Number.isFinite(claimAgeDays(s, AT))).toBe(true);
        expect(`${r.id} ${field}`).toBeTruthy();
      }
    }
  });

  test("QUOTES the page when it claims `documented` — if it cannot be quoted it is not documented", () => {
    for (const r of allCacheRules()) {
      if (r.ttlSeconds.confidence !== "documented") continue;
      expect(r.ttlSeconds.source.url).not.toBe("");
      expect(r.ttlSeconds.source.quote ?? "").not.toBe("");
    }
  });

  test("says what could not be confirmed when it is below `documented`", () => {
    for (const r of allCacheRules()) {
      const c = r.ttlSeconds.confidence;
      if (c === "documented" || c === "observed") continue;
      expect(r.ttlSeconds.note ?? "").not.toBe("");
    }
  });

  test("is never `observed` — that word is reserved for a live measurement", () => {
    for (const r of allCacheRules()) expect(r.ttlSeconds.confidence).not.toBe("observed");
  });

  test("states a positive TTL of at most a day", () => {
    for (const r of allCacheRules()) {
      expect(r.ttlSeconds.value).toBeGreaterThan(0);
      expect(r.ttlSeconds.value).toBeLessThanOrEqual(24 * 3600);
    }
  });

  test("comes from one of the four harnesses that ship rules", () => {
    const harnesses = [...new Set(allCacheRules().map((r) => r.harness))].toSorted();
    expect(harnesses).toEqual(["claude", "codex", "opencode", "pi"]);
  });

  test("keeps the figures cache-alert published, verbatim", () => {
    const ttl = (id: string) => allCacheRules().find((r) => r.id === id)?.ttlSeconds;
    expect(ttl("claude.subscription")?.value).toBe(3600);
    expect(ttl("claude.api")?.value).toBe(300);
    expect(ttl("codex.subscription")?.value).toBe(300);
    expect(ttl("codex.api")?.value).toBe(300);
    expect(ttl("opencode.anthropic")?.value).toBe(300);
    expect(ttl("opencode.openai")?.value).toBe(300);
    expect(ttl("opencode.google")?.value).toBe(180);
    expect(ttl("opencode.unknown")?.value).toBe(300);
    expect(ttl("opencode.google")?.confidence).toBe("reported");
    expect(ttl("opencode.unknown")?.confidence).toBe("inferred");
    // pi ships the same four numbers, from the same provider table.
    for (const key of ["anthropic", "openai", "google", "unknown"]) {
      expect(ttl(`pi.${key}`)?.value).toBe(ttl(`opencode.${key}`)?.value);
    }
  });
});

// ── the year gate ────────────────────────────────────────────────────────────

describe("newestReleaseDate", () => {
  test("takes the newest NUMBERED heading and ignores Unreleased", () => {
    const at = newestReleaseDate("## [Unreleased]\n\n## [1.8.2] - 2026-09-12\n\n## [1.8.1] - 2026-09-11\n");
    expect(at?.toISOString().slice(0, 10)).toBe("2026-09-12");
  });

  test("answers undefined for a changelog with no numbered heading yet", () => {
    expect(newestReleaseDate("## [Unreleased]\n\n### Added\n- something\n")).toBeUndefined();
  });
});

test("no shipped claim is more than a year older than this release", () => {
  // The gate's clock is the CHANGELOG, never the wall clock. Only the release commit writes that date
  // (`scripts/check-version.sh:8-11`), so the gate bites at exactly the moment a release would ship a
  // year-old number, which is the moment it should.
  const changelog = readFileSync(join(import.meta.dir, "..", "..", "CHANGELOG.md"), "utf8");
  const releasedAt = newestReleaseDate(changelog);
  expect(releasedAt).toBeDefined();
  if (releasedAt === undefined) return;
  const stale = staleClaims(allCacheRules(), 365, releasedAt);
  expect(stale.map((s) => `${s.ruleId} ${s.field} is ${String(s.ageDays)} days old`)).toEqual([]);
});

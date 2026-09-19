// Sourced claims — the contract every cache number in this tree must satisfy.
//
// Ported from AltanS/herdr-cache-alert (`src/claims.ts`), read 2026-09-12. The rule it states is the
// reason the port exists at all: a cache lifetime is VENDOR BEHAVIOUR, not a standard. Vendors change
// it without warning, it differs between a subscription and an API key, and half of what is written
// about it online is somebody's guess. So no bare constant is allowed anywhere under `bridge/cache/`:
// a number ships with a link, a date and the sentence it came from, or it does not ship.
//
// `retrievedAt` is the load-bearing field, and two mechanisms read it. `collie doctor` warns on a
// claim nobody has re-checked in 180 days, against the wall clock, because doctor is a live check of
// a live machine. A unit test FAILS the build on a claim more than 365 days older than the newest
// numbered heading in `CHANGELOG.md`, because that date is written by the release commit and by
// nothing else ({@link newestReleaseDate}) — so a tag's verdict never changes after the tag.
//
// See `.adr/0041-cache-rules-are-sourced-claims.md`.

export type Confidence =
  /** Stated outright in the vendor's own documentation. */
  | "documented"
  /** Stated by the vendor somewhere softer — a blog, a changelog, a support reply. */
  | "reported"
  /** Nobody documents it; derived from what IS documented. Say so out loud. */
  | "inferred"
  /** Measured from the harness's own transcript on this machine. Beats all of the above. */
  | "observed";

export type SourceKind = "vendor-doc" | "vendor-blog" | "vendor-changelog" | "community" | "observed";

export interface Source {
  /** The exact page the claim was read on. Never a search result, never a guess. */
  url: string;
  title: string;
  publisher: string;
  /** ISO date (YYYY-MM-DD) the claim was last checked against that page. */
  retrievedAt: string;
  /** Verbatim from the page. If it cannot be quoted, it is not `documented`. */
  quote?: string;
  kind: SourceKind;
}

export interface Sourced<T> {
  value: T;
  confidence: Confidence;
  source: Source;
  /** Anything a reader needs in order to not misread `value`. */
  note?: string;
}

/**
 * The observed case, where the "source" is this machine.
 *
 * Named `observedClaim` rather than cache-alert's bare `observed` because the bridge already has a
 * dozen modules in scope at a call site and a one-word export would read as a boolean there.
 */
export function observedClaim<T>(value: T, evidence: string, at: Date = new Date()): Sourced<T> {
  return {
    value,
    confidence: "observed",
    source: {
      url: "",
      title: evidence,
      publisher: "local telemetry",
      retrievedAt: at.toISOString().slice(0, 10),
      kind: "observed",
    },
  };
}

export type Tier = "subscription" | "api" | "unknown";

export interface CacheRule {
  /** Stable id, `<harness>.<key>` — what `cache-rules.toml` names. It must not move. */
  id: string;
  harness: string;
  tier: Tier;
  /** What an operator would call this setup. Another vendor's words, so it is not translated. */
  label: string;
  /** Idle seconds before the cached prefix is gone. THE number this feature exists for. */
  ttlSeconds: Sourced<number>;
  /** Smallest cacheable prefix, where the vendor states one. */
  minTokens?: Sourced<number>;
  /** Does a cache hit restart the clock, or does the TTL run from creation? */
  slidingWindow: boolean;
  /** Implicit caching, or does the caller have to place cache_control breakpoints? */
  automatic: boolean;
  /** Backing for `slidingWindow`, `automatic`, and anything in `notes`. */
  sources: Source[];
  notes?: string[];
}

/**
 * An action that drops the cached prefix while the TTL still runs.
 *
 * The clock is not the only way a cache dies. A model switch, an effort change or a compaction changes
 * the prefix, so the next turn rebuilds it however much time is left, and the chip used to show a warm
 * countdown over exactly that. Ported from AltanS/herdr-cache-alert `src/claims.ts` (commit 17fb2af).
 *
 * `resets` is SOURCED like a TTL, and it may be `false`. A documented NON-reset ships too: plain
 * `/reload-plugins` looks as if it should throw the cache away and does not, and saying so is the
 * answer an operator who suspects it needs.
 */
export interface ResetRule {
  /** Stable id, `<harness>.reset.<action>`. What a journal reports and the pane wire carries. */
  id: string;
  harness: string;
  /**
   * What happened, as the pane sheet names it: a clause that reads on its own, "The model changed".
   * Collie's words rather than a vendor's, and still not translated: it rides the pane wire from the
   * machine that detected it, and the phone slots it into a translated sentence.
   */
  label: string;
  resets: Sourced<boolean>;
  /**
   * When Collie can SEE the action. `before-turn`: it lands on disk as it happens, so the chip turns
   * cold before the operator pays for the rebuild. `after-turn`: only the next turn reveals it, so it
   * can explain a miss but never prevent one. `none`: the harness writes nothing Collie reads. That
   * is a gap, and it ships as a rule so the gap is visible.
   */
  detection: "before-turn" | "after-turn" | "none";
}

/** One sighting of a reset rule in a harness's transcript. Journals report these; the engine judges them. */
export interface ResetEvent {
  /** The {@link ResetRule.id} this matched. */
  ruleId: string;
  /** Epoch ms the action happened. Newer than the last request means it acts on the NEXT turn. */
  at: number;
  /** What was seen and where, for a log. Never transcript content. */
  evidence: string;
}

/** Days between `retrievedAt` and now. Infinity when the date is unparseable, so a bad date is stale. */
export function claimAgeDays(source: Source, now: Date = new Date()): number {
  const at = Date.parse(source.retrievedAt);
  if (Number.isNaN(at)) return Infinity;
  return Math.floor((now.getTime() - at) / 86_400_000);
}

export interface StaleClaim {
  ruleId: string;
  field: string;
  ageDays: number;
  source: Source;
}

/**
 * Every claim in `rules` and `resetRules` older than `maxDays`. Feeds `collie doctor`'s `cache-claims`
 * finding and the year gate, so a reset rule's quote rots as loudly as a TTL's.
 */
export function staleClaims(
  rules: readonly CacheRule[],
  maxDays: number,
  now: Date = new Date(),
  resetRules: readonly ResetRule[] = [],
): StaleClaim[] {
  const out: StaleClaim[] = [];
  const check = (ruleId: string, field: string, source: Source) => {
    // An observed claim is re-measured on every probe, so it cannot go stale.
    if (source.kind === "observed") return;
    const ageDays = claimAgeDays(source, now);
    if (ageDays > maxDays) out.push({ ruleId, field, ageDays, source });
  };
  for (const rule of rules) {
    check(rule.id, "ttlSeconds", rule.ttlSeconds.source);
    if (rule.minTokens) check(rule.id, "minTokens", rule.minTokens.source);
    rule.sources.forEach((source, i) => check(rule.id, `sources[${i}]`, source));
  }
  for (const rule of resetRules) check(rule.id, "resets", rule.resets.source);
  return out;
}

/** Every source one rule carries, each under the field name a finding would print. */
export function claimSources(rule: CacheRule): Array<[string, Source]> {
  const out: Array<[string, Source]> = [["ttlSeconds", rule.ttlSeconds.source]];
  if (rule.minTokens) out.push(["minTokens", rule.minTokens.source]);
  rule.sources.forEach((s, i) => out.push([`sources[${i}]`, s]));
  return out;
}

/** The newest numbered `## [x.y.z] - YYYY-MM-DD` heading, as `scripts/check-version.sh:22` reads it. */
const RELEASE_HEADING = /^##\s*\[(\d[^\]]*)\]\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/;

/**
 * The date on the newest numbered release heading in a CHANGELOG, or undefined.
 *
 * THE YEAR GATE'S CLOCK. `## [Unreleased]` is skipped because its bracket does not open with a digit,
 * which is the same rule `scripts/check-version.sh` applies with `\[\([0-9][^]]*\)\]`. Only the
 * release commit writes that date, so it is deterministic: every checkout of a tag passes or fails
 * the gate the same way forever, which is what makes a bisect and the VM lab safe.
 *
 * Exported so the test and any future release script share one parser rather than two regexes that
 * agree until they do not.
 */
export function newestReleaseDate(changelog: string): Date | undefined {
  for (const line of changelog.split("\n")) {
    const match = RELEASE_HEADING.exec(line.trim());
    if (!match) continue;
    const at = Date.parse(`${match[2] ?? ""}T00:00:00Z`);
    if (Number.isNaN(at)) return undefined;
    return new Date(at);
  }
  return undefined;
}

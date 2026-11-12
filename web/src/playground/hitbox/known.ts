// THE CENSUS AS A CHECK (hitbox investigation, proposal 7). The census (`e2e/hitbox/census.run.ts`) finds every
// tap target that is small or covered. Most of what it finds today is KNOWN: a chip drawn at 30px in a 30px
// strip, a control that a design decision keeps short. A check that failed on all of it would be turned off the
// first week, so the known ones are WRITTEN DOWN (`e2e/hitbox/known.json`) and the check fails on a target that
// is small or covered and not on that list: a NEW one.
//
// A target is known by its screen, its selector and its name, whatever the phone size: the two sizes are one
// target. Fixing a known target is good news and fails nothing; the check says so, so the list can shrink.
// Adding a target to the list is a person's decision, made with `--update` and read in the diff.

import type { Row } from "./data";

/** One known target. */
export interface KnownTarget {
  screen: string;
  selector: string;
  name: string;
  /** Why it stays: filled in by the person who accepted it, empty when it was taken as found. */
  why: string;
}

/** The verdicts the check holds to the list. `shifts` and `dead-time` are findings about time, not about a box. */
const CHECKED: ReadonlySet<string> = new Set(["small", "covered"]);

export const targetKey = (t: { screen: string; selector: string; name: string }): string => `${t.screen}\u0000${t.selector}\u0000${t.name}`;

export interface CheckResult {
  /** Small or covered, and not on the list. */
  fresh: Row[];
  /** On the list and no longer small or covered: the list can drop them. */
  fixed: KnownTarget[];
  /** Small or covered targets seen, counted once per screen, selector and name. */
  seen: number;
}

export function checkAgainstKnown(rows: readonly Row[], known: readonly KnownTarget[]): CheckResult {
  const knownKeys = new Set(known.map(targetKey));
  const flagged = new Map<string, Row>();
  for (const r of rows) {
    if (!CHECKED.has(r.verdict)) continue;
    const k = targetKey(r);
    // Two readings of one target (the two sizes): keep the more severe one.
    const held = flagged.get(k);
    if (held === undefined || r.severity > held.severity) flagged.set(k, r);
  }
  const fresh: Row[] = [];
  for (const [k, r] of flagged) if (!knownKeys.has(k)) fresh.push(r);
  fresh.sort((a, b) => b.severity - a.severity);
  const fixed = known.filter((t) => !flagged.has(targetKey(t)));
  return { fresh, fixed, seen: flagged.size };
}

/** The list as `--update` writes it: every small or covered target now, keeping the reason of one that was already known. */
export function nextKnown(rows: readonly Row[], known: readonly KnownTarget[]): KnownTarget[] {
  const why = new Map(known.map((t) => [targetKey(t), t.why]));
  const out = new Map<string, KnownTarget>();
  for (const r of rows) {
    if (!CHECKED.has(r.verdict)) continue;
    const k = targetKey(r);
    if (!out.has(k)) out.set(k, { screen: r.screen, selector: r.selector, name: r.name, why: why.get(k) ?? "" });
  }
  return [...out.values()].toSorted((a, b) => targetKey(a).localeCompare(targetKey(b)));
}

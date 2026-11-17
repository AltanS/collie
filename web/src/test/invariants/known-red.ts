// The tests of the invariant suites that are red on the base (M102 spec 15, decision 2). Each one stays
// in its suite as an expected failure (bun `test.failing`, vitest `it.fails`), named here with the spec
// that fixes it. When the fix lands the test passes, the runner reports an unexpected pass, and the lead
// removes its entry here and its expected-failure mark there. The release gate is an empty list:
// `bun scripts/invariant-red.ts --gate` exits 1 while any entry is left.
//
// `NONE` names a break that no spec of M102 covers. It is listed so the suite stays green, and the
// report says it loudly.
//
// Pure data: no DOM, no Bun API.

export type Invariant = "I1" | "I2" | "I3" | "I4" | "I5" | "I6" | "I7";

/** The spec that fixes a red test. `M102-03` is the phone's "Send past this screen" (rule 3), not on the candidate. */
export type FixingSpec = "M102-03" | "M102-10" | "M102-11" | "M102-12" | "M102-13" | "M102-14" | "NONE";

export interface KnownRed {
  readonly invariant: Invariant;
  readonly fixedBy: FixingSpec;
  /** The product code that breaks the invariant, file and line at stage 85caf9742. */
  readonly where: string;
  /** One sentence: what the person meets. */
  readonly what: string;
}

// Typed as a plain record, not `as const`: an empty list has no literal keys, and `keyof {}` is `never`,
// which would make every reader of an entry fail to compile. The release gate is this list being empty.
export const KNOWN_RED: Readonly<Record<string, KnownRed>> = {};

export type KnownRedId = string;

/** One entry by its id. The id is the tag a red test carries. */
export function knownRed(id: KnownRedId): KnownRed & { readonly id: KnownRedId } {
  return { id, ...entryOf(id) };
}

function entryOf(id: KnownRedId): KnownRed {
  const entry = KNOWN_RED[id];
  if (entry === undefined) throw new Error(`known-red: no entry named ${id}`);
  return entry;
}

/** The title suffix of a red test: the spec that fixes it, so a runner's list shows it. */
export function redTitle(id: KnownRedId): string {
  const entry = entryOf(id);
  return `[RED ${entry.invariant} FIXED_BY ${entry.fixedBy}: ${id}]`;
}

/** The entries per fixing spec. */
export function countBySpec() {
  const counts = { "M102-03": 0, "M102-10": 0, "M102-11": 0, "M102-12": 0, "M102-13": 0, "M102-14": 0, NONE: 0 } satisfies Record<FixingSpec, number>;
  for (const entry of Object.values(KNOWN_RED)) counts[entry.fixedBy] += 1;
  return counts;
}

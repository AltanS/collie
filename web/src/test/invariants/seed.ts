// The seeded generator of the invariant suites (M102 spec 15). No property-testing library is a
// dependency, so this is a small deterministic PRNG: a fixed list of seeds checked in, plus one fresh
// seed per run. Every failure message names the seed, and `INVARIANT_SEED=<n>` replays exactly that run.
//
// Pure: no DOM, no Bun API. Shared by the bridge's bun tests and the phone's vitest tests.

/** The seeds every run takes. Add a seed here when a fresh one found a break, so it is kept for ever. */
export const FIXED_SEEDS: readonly number[] = [1, 7, 42, 1729, 65_537];

/** A random source from one seed: mulberry32, 32 bits of state, good enough to pick cases. */
export interface Rng {
  readonly seed: number;
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [0, n). */
  int(n: number): number;
  /** One element of a non-empty list. */
  pick<T>(list: readonly T[]): T;
  /** True with probability p. */
  chance(p: number): boolean;
}

export function rngOf(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  return {
    seed,
    next,
    int,
    pick: <T>(list: readonly T[]): T => {
      if (list.length === 0) throw new Error("pick from an empty list");
      // SAFETY: the index is inside the list, which is not empty.
      return list[int(list.length)] as T;
    },
    chance: (p: number) => next() < p,
  };
}

/** The env of the running process, read the same way under bun and node. */
function envSeed(): string | undefined {
  // SAFETY: bun and node both put `process.env` on the global, as strings; only its one key is read.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.INVARIANT_SEED;
}

/**
 * The seeds of this run: `INVARIANT_SEED` alone when it is set (a replay), else the fixed list plus
 * one fresh seed. The fresh one is printed by every failure that names its seed.
 */
export function runSeeds(): readonly number[] {
  const asked = envSeed();
  if (asked !== undefined && asked !== "") {
    const seed = Number(asked);
    if (!Number.isInteger(seed)) throw new Error(`INVARIANT_SEED must be an integer, got ${asked}`);
    return [seed];
  }
  return [...FIXED_SEEDS, freshSeed()];
}

let fresh: number | null = null;

/** One fresh seed per process, the same for every suite in it. */
export function freshSeed(): number {
  if (fresh === null) fresh = Math.floor(Math.random() * 2_147_483_647);
  return fresh;
}

/** The line every failure carries, so a person can replay the case. */
export function replayHint(seed: number, caseId: string): string {
  return `seed ${String(seed)}, case ${caseId}; replay with INVARIANT_SEED=${String(seed)}`;
}

/**
 * Up to `n` elements of `list`, picked without repeats by the seed, in a stable order. The whole
 * list when it is not longer than `n`.
 */
export function sample<T>(list: readonly T[], n: number, rng: Rng): readonly T[] {
  if (list.length <= n) return list;
  const idx = list.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    // SAFETY: i and j are indexes inside idx, which has one entry per element of list.
    const a = idx[i] as number;
    // SAFETY: as above.
    idx[i] = idx[j] as number;
    idx[j] = a;
  }
  // SAFETY: every index in idx is inside list.
  return idx
    .slice(0, n)
    .toSorted((a, b) => a - b)
    .map((i) => list[i] as T);
}

/** One row of a product: one value of every axis. */
export type Row<T extends Record<string, readonly unknown[]>> = { [K in keyof T]: T[K][number] };

/** The cartesian product of a record of lists, as a list of rows. */
export function product<T extends Record<string, readonly unknown[]>>(axes: T): Row<T>[] {
  let out: Partial<Row<T>>[] = [{}];
  // SAFETY: Object.keys of `axes` are its own keys, so each is a key of T.
  for (const key of Object.keys(axes) as (keyof T)[]) {
    const values = axes[key];
    if (values === undefined) throw new Error(`product: axis ${String(key)} has no list`);
    const next: Partial<Row<T>>[] = [];
    for (const partial of out) for (const value of values) next.push({ ...partial, [key]: value });
    out = next;
  }
  // SAFETY: each row holds one value of every axis, by the loop above.
  return out as Row<T>[];
}

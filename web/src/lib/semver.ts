// ── VERSION ORDER, ON THE PHONE ─────────────────────────────────────────────────────────────────
//
// The twin of `compareSemver` in `bridge/update.ts`. The two trees cannot import one another (the web
// app builds without the Bun server's source tree), so the rule is written twice and pinned once:
// `bridge/crew-level-contract.test.ts` runs one list of pairs through both and fails when they
// disagree. Change one side and that test tells you about the other.
//
// Pure and import-free on purpose, so that bridge test can load this file as it is.

/** A dotted version, taken apart: the numeric triple, and the `-prerelease` tail as a STRING,
 *  because a prerelease sorts below the release it leads to and prereleases sort among themselves
 *  (`beta.9` < `beta.10`). `prerelease` null means "no tail". */
interface VersionParts {
  readonly triple: readonly [number, number, number];
  readonly prerelease: string | null;
}

/** The parts of a dotted version, with any `+build` tail dropped. */
function versionParts(v: string): VersionParts {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]*))?/.exec(v.trim());
  if (!m) return { triple: [0, 0, 0], prerelease: null };
  const tail = m[4];
  return {
    triple: [Number(m[1]), Number(m[2]), Number(m[3])],
    prerelease: tail === undefined || tail === "" ? null : tail,
  };
}

const NUMERIC_IDENTIFIER = /^\d+$/;

/** Two `-prerelease` tails by semver §11. `null`, no tail at all, sorts above every tail. */
function comparePrereleaseTails(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const xs = a.split(".");
  const ys = b.split(".");
  const shared = Math.min(xs.length, ys.length);
  for (let i = 0; i < shared; i++) {
    const x = xs[i] ?? "";
    const y = ys[i] ?? "";
    if (x === y) continue;
    const xNum = NUMERIC_IDENTIFIER.test(x);
    const yNum = NUMERIC_IDENTIFIER.test(y);
    if (xNum && yNum) return Number(x) < Number(y) ? -1 : 1;
    if (xNum !== yNum) return xNum ? -1 : 1;
    return x < y ? -1 : 1;
  }
  if (xs.length === ys.length) return 0;
  return xs.length < ys.length ? -1 : 1;
}

/**
 * Compare two dotted `X.Y.Z` versions (no leading `v`). Returns -1, 0 or 1.
 *
 * `1.0.0-beta.9` < `1.0.0-beta.10` < `1.0.0-rc.1` < `1.0.0`, and a `+build` tail never decides
 * anything. Twin of `bridge/update.ts`'s `compareSemver` (see this file's header).
 */
export function compareSemver(a: string, b: string): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < 3; i++) {
    const x = pa.triple[i] ?? 0;
    const y = pb.triple[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return comparePrereleaseTails(pa.prerelease, pb.prerelease);
}

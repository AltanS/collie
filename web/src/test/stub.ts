// One typed seam for the partial fakes the suite hands to production code.
//
// A test that needs "a PointerEvent, but only the three fields the hook reads" used to write
// `{ button, clientX, clientY } as unknown as ReactPointerEvent` — a chain that discards the type
// entirely, so a renamed or re-typed field on the real interface goes unnoticed. `stubPart` keeps
// the check: `Partial<T>` still validates every field the fake DOES supply against the real type,
// and only the "the rest is missing" step is asserted, in one place, with the reason written down.

/**
 * A stand-in for `T` carrying only the fields the caller supplies.
 *
 * Use it where the code under test provably reads a known subset; anything it reads that the fake
 * omits is a real `undefined` at runtime, which is the failure the case is meant to show.
 */
export function stubPart<T>(impl: Partial<T>): T {
  // SAFETY: `Partial<T>` typechecks every field supplied against `T`, so the only thing widened
  // here is completeness — the fields NOT supplied. Callers pass this to code whose reads are known
  // and covered; an uncovered read surfaces as an ordinary `undefined` failure in the case itself.
  return impl as T;
}

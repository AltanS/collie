// What Settings → Experiments holds, and therefore whether that section exists at all.
//
// ── WHY A FIFTH SECTION AND NOT A CARD IN APPEARANCE ─────────────────────────
// "Experimental" is a property of a SECTION'S CONTRACT, not an adjective on a card: everything
// filed here may change shape, lose settings, or be withdrawn in a patch release, and that sentence
// is worth saying once at the top rather than repeating per row. Appearance is also the wrong
// neighbour on its own terms — read its header comments in `routes/settings-sections.tsx`: every
// card there answers "what do I want on screen", the ordering is argued card by card, and
// `ToolCallsControl` is already flagged there as "the odd one". An unstable toggle dropped into
// that page breaks the rule the page states about itself.
//
// ── AND WHY THE SECTION CAN DISAPPEAR ────────────────────────────────────────
// An Experiments row that opens an empty page is noise, and Chat will not be the last thing to pass
// through here (it was the first, and left in 1.17.0, ADR 0082). So the index row renders only while
// this list has something in it: adding an experiment is a row here plus its card on the section,
// and removing the last one takes the section off the index with no other edit.

/** Every experiment the section holds today, newest last. Empty since Chat graduated (ADR 0082). */
export const EXPERIMENTS = [] as const;

/** One experiment's name, so a card naming something nobody built is a compile error. */
export type ExperimentId = (typeof EXPERIMENTS)[number];

/** Whether Settings → Experiments has anything in it — what the index row is gated on. */
export function hasExperiments(): boolean {
  return EXPERIMENTS.length > 0;
}

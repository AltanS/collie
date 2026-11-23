import { useEffect, useRef } from "react";

import { dropSpaceLanding, landingStep, type LandingClear, type LandingFacts } from "@/lib/space-landing";

/**
 * Where `open_space` lands on a large screen: the Dashboard, at one space (lib/space-landing.ts). It draws
 * nothing. The list mounts it while an ask is waiting, and on every commit it asks what is next: clear the
 * one choice that hides the space, or, with nothing hiding it, bring its column into view and put the focus
 * on the column's first row (the row's own focus ring, as `reveal` after a pin).
 *
 * Instant, not smooth: the Dashboard has just arrived, so there is no earlier position to glide from. The
 * route's scroll memory has already put the list back where it was (a layout effect), so this moves it on
 * from there. A clear is a stored change, so it draws again and the next commit lands. Each clear runs once:
 * "hide" is a toggle, and a second pass before the first draws must not flip it back. A step that comes up again
 * after it ran has nothing left to try: the landing is dropped. So is a landing still waiting when this unmounts.
 */
export function SpaceLanding({
  facts,
  clear,
  columnId,
  rowId,
}: {
  facts: LandingFacts;
  clear: Readonly<Record<LandingClear, () => void>>;
  /** The DOM id of the space's column, when the list draws columns (the place order). */
  columnId: string | null;
  /** The DOM id of the first row to focus: the column's first, or in a ranked list the space's first row. */
  rowId: string | null;
}) {
  const cleared = useRef(new Set<LandingClear>());
  // A landing never outlives the navigation that asked for it: when the Dashboard goes away without having landed,
  // the ask goes with it.
  useEffect(() => dropSpaceLanding, []);
  useEffect(() => {
    const step = landingStep(facts);
    if (step.kind === "none") return dropSpaceLanding();
    if (step.kind === "clear") {
      // The step was tried and still hides the space (a clear this list cannot do, or one that did not take): nothing
      // is left to try, so the ask is spent and does not wait for a later, unrelated visit.
      if (cleared.current.has(step.what)) return dropSpaceLanding();
      cleared.current.add(step.what);
      return clear[step.what]();
    }
    const row = rowId === null ? null : document.getElementById(rowId);
    if (row === null) return;
    // A list that is not drawn yet takes no focus (the Dashboard keeps its list unseen for a moment while the
    // install-count notice is read, `visibility: hidden`): wait for the next commit and ask again.
    row.focus({ preventScroll: true });
    if (document.activeElement !== row) return;
    const column = columnId === null ? null : document.getElementById(columnId);
    column?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    row.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    dropSpaceLanding();
  });
  return null;
}

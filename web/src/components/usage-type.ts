// THE TYPE OF THE USAGE ROW, in one place, so the usage figures and a trick's status chip beside them cannot
// drift apart (the operator, 2026-11-18: "there needs to be a default font size and colour so it matches what we
// have for the usage data points"). `components/model-tag.tsx` draws the row's own items with these, and
// `components/trick-status-item.tsx` draws a chip with the same two.
//
// THE ROW'S TYPE: 10px on a 12px line, the regular weight, the muted foreground. The family is the page's
// own (nothing here sets one). A trick cannot set any of it; it only names a tone (lib/tricks/tone.ts `rowInkOf`).
export const USAGE_TYPE = "text-[10px]/3 font-normal text-muted-foreground";

/** A FIGURE of the row: digits of one width, so the row does not jitter as a number changes. */
export const USAGE_FIGURE = "tabular-nums";

/** The side of an icon in the row, in px: the 10px of its type, as wide as the letters beside it. A gauge draws none; a trick's chip may. */
export const USAGE_ICON = "size-2.5";

// THE STATUS LINE'S OVERFLOW RULE (M94 re-cut, the `status` place), as one pure reading. The usage row
// (components/model-tag.tsx) is one line with two ends: the tricks' status items start at the LEFT end in
// manifest order, and Collie's own items (the model name, the usage) end at the RIGHT end. The empty space
// between them gives way first, to a least gap. A trick's chip KEEPS ITS PLACE: when the line is wider than the room it has, the MODEL TAG gives
// way first, in its own shorter forms (`Opus 5.5 · medium`, then `Opus 5.5`, then the name cut short with
// an ellipsis), and the usage figures stay as they are (their own rule is the window count in model-tag.tsx).
// Only when the chips themselves are more than the row can hold, with the model name down to its floor, do
// the tricks give way, the newest (the last in manifest order, the one nearest the middle) before the older. The
// operator asked for this on 2026-11-17, and for the left end on 2026-11-18: his Claude rows are full at
// 360px, a chip is the thing he wanted to see, and the left of the row was empty. `ModelTag` measures; this decides.

export interface StatusFit {
  /** The room the line has, in px (the tag's max width less its own padding). */
  room: number;
  /** The natural width of Collie's own items together, in px. 0 when there are none. */
  own: number;
  /** The gap between two items, in px. */
  gap: number;
  /** The natural width of each trick item, in manifest order. */
  widths: readonly number[];
  /** The gap before the first trick item, in px, when it differs from `gap`: the empty space the two ends keep between them. Default `gap`. */
  lead?: number;
}

/**
 * How many of the trick items show, from the first. An item shows when it fits after everything before
 * it; the first one that does not fit hides itself and every later one, so a small item never jumps over
 * a large one that gave way. With no room for even the first, none show.
 */
export function visibleStatusCount({ room, own, gap, widths, lead = gap }: StatusFit): number {
  let used = own;
  for (let i = 0; i < widths.length; i++) {
    const next = used + (used > 0 ? (i === 0 ? lead : gap) : 0) + (widths[i] ?? 0);
    if (next > room) return i;
    used = next;
  }
  return widths.length;
}

/** The narrowest the model name is drawn before a trick's chip gives way, in px: a few letters and an ellipsis. */
export const LABEL_FLOOR = 24;

export interface RowFit {
  /** The room the line has, in px (the tag's max width less its own padding). */
  room: number;
  /** The natural width of Collie's own items other than the model name (gauges, count, cost), with their gaps. 0 when there are none. */
  fixed: number;
  /** The gap between two items, in px. */
  gap: number;
  /** The model name's forms, widest first (`Opus 5.5 · medium`, `Opus 5.5`), in px. Empty when no name is drawn. */
  forms: readonly number[];
  /** The natural width of each trick item, in manifest order. */
  widths: readonly number[];
  /** The least gap between the chips at the left end and the model and usage at the right end, in px. Default `gap`. */
  between?: number;
}

export interface RowFitResult {
  /** How many trick items show, from the first. */
  count: number;
  /** Which of `forms` the name is drawn in; the last one is also the one CSS cuts with an ellipsis. 0 with no forms. */
  form: number;
}

/**
 * The status line's whole fit. The chips are counted first, against the room left once the name is at its
 * floor ({@link LABEL_FLOOR}, or its shortest form when that is narrower), so a chip never gives way to the
 * model name. The name then takes the widest form that fits beside the chips that stayed.
 */
export function fitStatusRow({ room, fixed, gap, forms, widths, between = gap }: RowFit): RowFitResult {
  const shortest = forms[forms.length - 1];
  const floor = shortest === undefined ? 0 : Math.min(LABEL_FLOOR, shortest);
  const own = shortest === undefined ? fixed : floor + (fixed > 0 ? gap + fixed : 0);
  const count = visibleStatusCount({ room, own, gap, widths, lead: between });
  if (shortest === undefined) return { count, form: 0 };
  const chips = count === 0 ? 0 : between + widths.slice(0, count).reduce((sum, w) => sum + w, 0) + gap * (count - 1);
  const beside = (fixed > 0 ? gap + fixed : 0) + chips;
  const available = room - beside;
  const form = forms.findIndex((w) => w <= available);
  return { count, form: form === -1 ? forms.length - 1 : form };
}

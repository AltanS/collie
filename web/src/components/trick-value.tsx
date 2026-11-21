import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { t, type MessageKey, type TemplateVars } from "@/lib/i18n";

// A VALUE ON A TRICK'S DETAIL PAGES (the About sheet's facts, the Settings group). The labels and the plain
// sentences stay in the muted foreground; a value, which is the one thing a person reads the row for (the
// timer, a version, a path, an environment name), is drawn on a small chip: the normal foreground at medium
// weight on `muted`, with a uniform 1px border (`ui/badge.tsx`, the `value` variant). A phrase or a list (the
// places, several names) is not a chip: it is plain text at the same weight (`isChipValue`). Nothing scrolls sideways.

const OPEN = "\uE000";
const CLOSE = "\uE001";
const MARKED = /\uE000([^\uE001]*)\uE001/u;

/** The longest value that still stands on a chip. A longer one, or a list, is a phrase. */
export const CHIP_MAX = 24;

/**
 * Whether a value is a short literal (a duration, a file name, an environment name, a version), drawn on a chip.
 * A value longer than {@link CHIP_MAX} characters, or a list (it holds a comma), is a phrase: a chip around it
 * breaks over lines into chip pieces, so it is drawn as plain text in the emphasised weight, with no box
 * (2026-11-21). The words and their order do not change.
 */
export function isChipValue(value: string): boolean {
  return value.length <= CHIP_MAX && !value.includes(",");
}

/** A phrase-length value: plain text in the row, the normal foreground at medium weight, no box. */
export function TrickValueText({ children }: { children: ReactNode }) {
  return (
    <span data-slot="trick-value-text" className="font-medium break-words text-foreground">
      {children}
    </span>
  );
}

/** One value on its chip. It is inline in a sentence and breaks anywhere inside a long word, like the text around it. */
export function TrickValue({ children }: { children: ReactNode }) {
  return (
    <Badge variant="value" data-slot="trick-value" className="inline w-auto max-w-full shrink px-1.5 py-px align-baseline text-[0.9em] leading-snug font-medium break-words whitespace-normal [box-decoration-break:clone]">
      {children}
    </Badge>
  );
}

/**
 * A translated sentence with some of its slots drawn as {@link TrickValue}: `values` are the slots to chip, `plain`
 * the rest. The words around a slot are the dictionary's, in every language, so the chip lands where the language
 * puts the slot. The text of the result is the sentence `t()` would have written.
 */
export function valueSentence(key: MessageKey, values: TemplateVars, plain: TemplateVars = {}): ReactNode[] {
  // A value never carries the two private-use marks it is found by.
  const marked = { ...plain, ...Object.fromEntries(Object.entries(values).map(([slot, value]) => [slot, `${OPEN}${String(value).replaceAll(OPEN, "").replaceAll(CLOSE, "")}${CLOSE}`])) };
  const parts = t(key, marked).split(MARKED);
  // `split` with one capture group alternates text, value, text, value, ... text.
  return parts.map((part, index) => {
    if (index % 2 === 0) return part === "" ? null : part;
    return isChipValue(part) ? <TrickValue key={index}>{part}</TrickValue> : <TrickValueText key={index}>{part}</TrickValueText>;
  });
}

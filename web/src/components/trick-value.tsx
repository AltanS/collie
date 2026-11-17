import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { t, type MessageKey, type TemplateVars } from "@/lib/i18n";

// A VALUE ON A TRICK'S DETAIL PAGES (the About sheet's facts, the Settings group). The labels and the plain
// sentences stay in the muted foreground; a value, which is the one thing a person reads the row for (the
// timer, the places, the run line, a version, a path), is drawn on a small chip: the normal foreground at
// medium weight on `muted`, with a uniform 1px border (`ui/badge.tsx`, the `value` variant). A long value wraps
// inside its chip; nothing scrolls sideways.

const OPEN = "\uE000";
const CLOSE = "\uE001";
const MARKED = /\uE000([^\uE001]*)\uE001/u;

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
  return parts.map((part, index) => (index % 2 === 1 ? <TrickValue key={index}>{part}</TrickValue> : part === "" ? null : part));
}

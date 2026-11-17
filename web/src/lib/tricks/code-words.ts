// THE WORDS OF A TRICK'S SCHEDULE AND OF A MARK IN ITS CODE, for the About sheet (components/trick-about-sheet.tsx,
// components/trick-code-folds.tsx). Pure: the phone's own words and the numbers the bridge sends.

import { t, type MessageKey } from "@/lib/i18n";

import { WATCH_WINDOW_MS } from "./limits";
import { TRICK_WARNING_KINDS, type TrickWarningKind } from "./schema";

/** A span in the unit a person reads: `30 s`, `5 min`, `2 h`. A whole number of the largest unit that divides it. */
export function spanWords(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return t("settings.tricks.about.span.h", { n: ms / 3_600_000 });
  if (ms >= 60_000 && ms % 60_000 === 0) return t("settings.tricks.about.span.min", { n: ms / 60_000 });
  return t("settings.tricks.about.span.s", { n: Math.round(ms / 1000) });
}

/**
 * When a trick's program runs, in the words of what the runner does (bridge/tricks/service.ts, "WHEN A TRICK
 * RUNS"): once when it starts, then `every` after the last run, and only while a phone has looked in the last
 * {@link WATCH_WINDOW_MS}. A trick with no `every` runs at start and on a tap, never on a clock.
 */
export function timerLine(everyMs: number | undefined): string {
  if (everyMs === undefined) return t("settings.tricks.about.noTimer");
  return t("settings.tricks.about.timer", { every: spanWords(everyMs), window: spanWords(WATCH_WINDOW_MS) });
}

function isKnownKind(kind: string): kind is TrickWarningKind {
  return TRICK_WARNING_KINDS.some((known) => known === kind);
}

/** The one word of a mark: the phone's own for a kind it knows, the bridge's own word for another. */
export function markWord(kind: string): string {
  return isKnownKind(kind) ? t(`settings.tricks.about.code.mark.${kind}` satisfies MessageKey) : kind;
}

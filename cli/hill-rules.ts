/**
 * How to word a trick's ask, for a person who opens the card cold. Written into the AGENTS.md of
 * `collie trick init`. Two lines; the soft limits below ({@link hillWordingWarnings}) are what enforces them.
 * It imports nothing, so the browser leg's rig (web/e2e/rig/harnesses.ts) can read it without pulling the
 * bridge into the web typecheck. Until ADR 0179 `collie hill --help` printed it too.
 */
export const HILL_WRITING = [
  "Title: the ask as a question, about 8 words, no inner ids. Summary: one or two plain sentences; the first says what your recommendation does.",
  'Options start with a verb ("Ship it", "Hold until CI"), never a bare Yes or No. Recommend one: --recommend <intent> --why "<reason>".',
] as const;

/** The title's soft limit in characters (`HILL_WRITING`); the hard cap is the wire's. */
export const HILL_TITLE_SOFT_MAX = 60;
/** The summary's soft limits: sentences and characters. */
export const HILL_SUMMARY_SOFT_SENTENCES = 2;
export const HILL_SUMMARY_SOFT_MAX = 200;

/** The parts of an ask the wording warnings read: a trick's ask. */
export interface HillWording {
  readonly title: string;
  readonly summary: string;
  readonly options?: readonly { readonly intent: string; readonly label: string }[];
}

/** Characters as a person counts them: code points, not UTF-16 units. */
function chars(text: string): number {
  return [...text].length;
}

/** The sentences of a text: split after `.`, `!`, `?` or `…` (and a closing quote or bracket) where white space follows. */
export function sentenceCount(text: string): number {
  return text
    .trim()
    .split(/(?<=[.!?…。！？]["'”’)\]]*)\s+/u)
    .filter((s) => s.trim() !== "").length;
}

/**
 * The soft warnings for an ask's words, one sentence each, never a refusal: a long title, a title that
 * asks nothing, a summary past two sentences or 200 characters, an option that is only Yes, No or OK.
 */
export function hillWordingWarnings(d: HillWording): string[] {
  const out: string[] = [];
  const title = d.title.trim();
  if (chars(title) > HILL_TITLE_SOFT_MAX) out.push(`the title has ${String(chars(title))} characters. Keep it to ${String(HILL_TITLE_SOFT_MAX)}: the ask as a short question.`);
  if (!/[?？؟]/u.test(title)) out.push("the title asks no question. Write the ask as a question the options answer.");
  const sentences = sentenceCount(d.summary);
  if (sentences > HILL_SUMMARY_SOFT_SENTENCES) out.push(`the summary has ${String(sentences)} sentences. Keep it to two: what the recommended option does, then the fact that decides it.`);
  const summaryChars = chars(d.summary.trim());
  if (summaryChars > HILL_SUMMARY_SOFT_MAX) out.push(`the summary has ${String(summaryChars)} characters. Keep it under ${String(HILL_SUMMARY_SOFT_MAX)}, and put the evidence in the view or the body.`);
  for (const option of d.options ?? []) {
    if (/^(?:yes|no|ok|okay)[.!]?$/iu.test(option.label.trim())) out.push(`option "${option.intent}" says only "${option.label.trim()}". Start it with a verb that says what happens, such as "Ship it".`);
  }
  return out;
}

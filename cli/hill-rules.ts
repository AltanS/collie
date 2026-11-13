/**
 * The rules every agent reads before it posts, in `collie hill --help` (and `collie hill post --help`, the same
 * text) and in the AGENTS.md of `collie trick init`. The installed WalkyTalky skill no longer holds them: its
 * Hill section is a few lines and points at `collie hill --help` (spec M96/11, "as slim and bare as possible").
 * One source: edit the words here only. It imports nothing, so the browser leg's rig (web/e2e/rig/harnesses.ts)
 * can read it without pulling the bridge into the web typecheck.
 */
export const HILL_RULES = [
  "Post only what needs your person. A worker with a lead asks its lead first.",
  "One question per post. To change it, post again with --supersedes <id>.",
  'Do not wait or poll. The answer starts your next turn as "Answer to <id> ...". None arrived: collie hill status <id>.',
  "Settled in your session: collie hill withdraw <id>.",
  'A result that ends "Crew state: quiet." or "Crew state: away.": your person is not there. Ask nothing that needs an answer now.',
] as const;

/**
 * How to word a Decision, for a person who opens the card cold. Printed by `collie hill --help` above the
 * rules and written into the AGENTS.md of `collie trick init`. Two lines, as bare as the help can hold; the
 * soft limits below ({@link hillWordingWarnings}) are what enforces them. The fuller advice for a person
 * is in docs/hill.md ("The words of a card"). The installed skill holds neither list.
 */
export const HILL_WRITING = [
  "Title: the decision as a question, about 8 words, no inner ids. Summary: one or two plain sentences; the first says what your recommendation does.",
  'Options start with a verb ("Ship it", "Hold until CI"), never a bare Yes or No. Recommend one: --recommend <intent> --why "<reason>".',
] as const;

/** The title's soft limit in characters (`HILL_WRITING`); the hard cap is the wire's. */
export const HILL_TITLE_SOFT_MAX = 60;
/** The summary's soft limits: sentences and characters. */
export const HILL_SUMMARY_SOFT_SENTENCES = 2;
export const HILL_SUMMARY_SOFT_MAX = 200;

/** The parts of a Decision the wording warnings read: a `collie hill post` and a trick's Decision alike. */
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
 * The soft warnings for a Decision's words, one sentence each, never a refusal: a long title, a title that
 * asks nothing, a summary past two sentences or 200 characters, an option that is only Yes, No or OK.
 */
export function hillWordingWarnings(d: HillWording): string[] {
  const out: string[] = [];
  const title = d.title.trim();
  if (chars(title) > HILL_TITLE_SOFT_MAX) out.push(`the title has ${String(chars(title))} characters. Keep it to ${String(HILL_TITLE_SOFT_MAX)}: the decision as a short question.`);
  if (!/[?？؟]/u.test(title)) out.push("the title asks no question. Write the decision as a question the options answer.");
  const sentences = sentenceCount(d.summary);
  if (sentences > HILL_SUMMARY_SOFT_SENTENCES) out.push(`the summary has ${String(sentences)} sentences. Keep it to two: what the recommended option does, then the fact that decides it.`);
  const summaryChars = chars(d.summary.trim());
  if (summaryChars > HILL_SUMMARY_SOFT_MAX) out.push(`the summary has ${String(summaryChars)} characters. Keep it under ${String(HILL_SUMMARY_SOFT_MAX)}, and put the evidence in the view or the body.`);
  for (const option of d.options ?? []) {
    if (/^(?:yes|no|ok|okay)[.!]?$/iu.test(option.label.trim())) out.push(`option "${option.intent}" says only "${option.label.trim()}". Start it with a verb that says what happens, such as "Ship it".`);
  }
  return out;
}

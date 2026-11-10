/**
 * The rules every agent reads before it posts, in `collie hill --help` and `collie hill post --help`, and
 * in the "Decisions (the hill)" part of the installed WalkyTalky skill (`renderWalkySkill` in
 * cli/skill-install.ts fills `{{HILL_RULES}}` from this list). One source: edit the words here only. It
 * imports nothing, so the browser leg's rig (web/e2e/rig/harnesses.ts) can read it without pulling the
 * bridge into the web typecheck.
 */
export const HILL_RULES = [
  "Post a decision only for what needs the person.",
  "Always write the summary in plain words, and recommend one option with a why.",
  "One question per decision. To change one, post again with --supersedes; never repost.",
  "Do not wait in a loop. The answer arrives as a WalkyTalky message and starts your next turn.",
  "If no answer arrived, read it with collie hill status <id>.",
  "An answer typed into your session for a decision you did not post carries only the id and the option word. Read the rest with collie hill status <id>.",
  "A worker with a lead asks its lead first.",
  "A --view only shows facts. No buttons: the options are the taps.",
] as const;

/**
 * How to word a Decision, for a person who opens the card cold. Printed by `collie hill post --help` and
 * `collie hill --help` above the rules, and written into the AGENTS.md of `collie trick init`. Kept apart
 * from {@link HILL_RULES} on purpose: that list is also the installed WalkyTalky skill's text, and a change
 * there makes every installed skill stale and the browser leg's recordings miss. The helper's `t.decide`
 * comment and web/src/lib/tricks/README.md say the same in fewer words; change them with this list.
 */
export const HILL_WRITING = [
  "Word the card for a person who opens it cold, between other things:",
  '- Title: the decision itself, as a question the options answer. Name the thing and the act, in about 8 words (at most 60 characters). Good: "Ship 1.28.1 to Stable now?" Bad: "Are the new kinds right?"',
  "- No inner names or ids in the title that the person would not know.",
  "- Summary: at most two sentences. The first says what the recommended option does, the second gives the one fact that decides it. Put the evidence in the view or the body.",
  '- Each option starts with a verb and says what happens: "Ship it", "Hold until CI". Never a bare Yes or No.',
  "- --priority now sends a notification to the person's phone. Use it only for what cannot wait.",
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

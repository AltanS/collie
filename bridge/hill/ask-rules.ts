// The rules of an ask (Asks, 2026-11-22): a post from `collie walky ask`, checked by the bridge beside the
// rules every Decision meets (service.ts `cleanPost`, run with the ask's own limits). Pure. The CLI checks
// the same rules first (cli/ask.ts) and says them in its own words; these are the bridge's, so a socket
// line that skipped the CLI meets them too. Each refusal names the flag and the limit, as the CLI's do.

import {
  HILL_ASK_BARE_LABELS,
  HILL_ASK_BODY_MAX,
  HILL_ASK_DOES_MAX,
  HILL_ASK_FACT_MAX,
  HILL_ASK_LABEL_MAX,
  HILL_ASK_OPEN_MAX,
  HILL_ASK_OPTIONS_MAX,
  HILL_ASK_OPTIONS_MIN,
  HILL_ASK_QUESTION_MAX,
  HILL_ASK_WHY_MAX,
  HILL_BODY_MAX,
  HILL_OPTION_DETAIL_MAX,
  HILL_OPTION_LABEL_MAX,
  HILL_SUMMARY_MAX,
  HILL_TITLE_MAX,
  HILL_WHY_MAX,
  type HillDecision,
  type HillRefusalCode,
} from "../../web/src/lib/hill/wire.ts";

/** The caps `cleanPost` measures a post's fields against. */
export interface HillPostLimits {
  readonly title: number;
  readonly summary: number;
  readonly body: number;
  readonly label: number;
  readonly detail: number;
  readonly why: number;
}

/** The Hill's own caps, for every Decision that is not an ask. */
export const HILL_LIMITS: HillPostLimits = { title: HILL_TITLE_MAX, summary: HILL_SUMMARY_MAX, body: HILL_BODY_MAX, label: HILL_OPTION_LABEL_MAX, detail: HILL_OPTION_DETAIL_MAX, why: HILL_WHY_MAX };

/** An ask's caps. */
export const HILL_ASK_LIMITS: HillPostLimits = { title: HILL_ASK_QUESTION_MAX, summary: HILL_ASK_FACT_MAX, body: HILL_ASK_BODY_MAX, label: HILL_ASK_LABEL_MAX, detail: HILL_ASK_DOES_MAX, why: HILL_ASK_WHY_MAX };

/** A refusal: the contract's code and the words the CLI prints. */
export interface AskRefusal {
  readonly code: HillRefusalCode;
  readonly error: string;
}

/** Whether an option label is a bare word that says nothing (Yes, No, OK, Cancel). */
export function isBareLabel(label: string): boolean {
  return HILL_ASK_BARE_LABELS.includes(label.trim().replace(/\.$/u, "").trim().toLowerCase());
}

/**
 * Why a cleaned ask breaks a rule of its own, or null. The lengths were measured already (`cleanPost` with
 * {@link HILL_ASK_LIMITS}); here: the question ends with `?`, a `--words` ask has no options and every other
 * ask 2 to 5, no bare label, and every option says what it does.
 */
export function askRuleRefusal(fields: Pick<HillDecision, "title" | "options">, words: boolean): AskRefusal | null {
  if (!fields.title.endsWith("?")) return { code: "bad_title", error: 'the question must end with "?"' };
  if (words) {
    return fields.options.length === 0 ? null : { code: "bad_option", error: "--words takes no --option: the answer is your operator's own words" };
  }
  const count = fields.options.length;
  if (count < HILL_ASK_OPTIONS_MIN || count > HILL_ASK_OPTIONS_MAX) {
    return { code: "bad_option", error: `--option must be given ${String(HILL_ASK_OPTIONS_MIN)} to ${String(HILL_ASK_OPTIONS_MAX)} times. You gave ${String(count)}. An ask with no options takes --words` };
  }
  for (const option of fields.options) {
    if (isBareLabel(option.label)) return { code: "bad_option", error: `--option ${option.intent} label "${option.label}" is not allowed: an option says what happens, start it with a verb` };
    if (option.detail === undefined || option.detail === "") return { code: "bad_option", error: `--does ${option.intent} is required: a reader with no memory cannot judge a bare label` };
  }
  return null;
}

/** The refusal of one ask too many: the session's open asks, id and question, and the way out. */
export function tooManyAsks(open: readonly Pick<HillDecision, "id" | "title">[]): string {
  const list = open.map((ask) => `${ask.id} "${ask.title}"`).join("; ");
  return `this session has ${String(open.length)} open asks, the limit is ${String(HILL_ASK_OPEN_MAX)}: ${list}. Take one back or replace one: collie walky cancel <id>, or collie walky ask ... --replaces <id>`;
}

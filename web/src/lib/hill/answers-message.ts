// The one message a Send types into a session (Asks, 2026-11-22): every answer the person marked for the
// session's open asks, one line each, then a line for each open ask that got no answer in this Send. The
// bridge types exactly this text (bridge/hill/service.ts `answerAsks`, and the single answer to an ask);
// the phone's review page shows it before Send, and blocks Send when it is too long. Pure: no I/O.
//
// The form, one ask per line, the id first so the agent finds each one:
//
//   <id> "<question>": <option id> (<label>), as recommended.
//   <id> "<question>": <option id> (<label>), not the recommended option. Note: <note>
//   <id> "<question>": <option id> (<label>). Note: <note>            (no recommendation on the ask)
//   <id> "<question>": I need more context. Note: <note>. Send the ask again with a better background: collie walky ask ... --replaces <id>
//   <id> "<question>": <the words>                                     (a --words ask)
//   <id> "<question>": no answer yet, it stays open.
//
// A note is optional everywhere; with none the "Note:" part is left out. A note or words with line
// breaks keep them, each further line indented by two spaces, so a line that starts at the margin is
// always the start of an ask.

import { HILL_ANSWERS_MESSAGE_MAX, HILL_MORE_CONTEXT, type HillDecision } from "./wire";

/** The subject the one message carries (WalkyTalky's subject line, at most six words). */
export const ASKS_ANSWERS_SUBJECT = "Answers to your asks";

/** What the message reads of an ask. */
export type AnsweredAsk = Pick<HillDecision, "id" | "title" | "recommends" | "options">;

/** One marked answer: the ask, the intent (an option, `more-context`, or `answer` on a `--words` ask), and the note or the words. */
export interface MarkedAnswer {
  readonly ask: AnsweredAsk;
  readonly intent: string;
  readonly text: string | null;
}

/** Line breaks kept, each further line indented two spaces, the ends trimmed. */
function indented(text: string): string {
  return text
    .trim()
    .split(/\r?\n/u)
    .map((line, i) => (i === 0 ? line : `  ${line}`))
    .join("\n");
}

/** A note as the message carries it, or null for none. */
function noteOf(text: string | null): string | null {
  if (text === null) return null;
  const note = indented(text);
  return note === "" ? null : note;
}

/** The start of every line: the id and the question. */
function head(ask: Pick<AnsweredAsk, "id" | "title">): string {
  return `${ask.id} "${ask.title}":`;
}

/** The fixed tail of a "more context" line: how the agent sends the ask again. */
export function moreContextTail(id: string): string {
  return `Send the ask again with a better background: collie walky ask ... --replaces ${id}`;
}

/** One marked answer as its line. */
export function answerLine(answer: MarkedAnswer): string {
  const { ask, intent } = answer;
  const note = noteOf(answer.text);
  if (intent === HILL_MORE_CONTEXT) {
    // The note ends with a period of its own unless it already ends a sentence.
    const said = note === null ? "" : ` Note: ${note}${/[.!?]$/u.test(note) ? "" : "."}`;
    return `${head(ask)} I need more context.${said} ${moreContextTail(ask.id)}`;
  }
  if (intent === "answer") return `${head(ask)} ${note ?? ""}`.trimEnd();
  const label = ask.options.find((option) => option.intent === intent)?.label ?? intent;
  const picked = `${head(ask)} ${intent} (${label})`;
  const tail = note === null ? "" : ` Note: ${note}`;
  if (ask.recommends === null) return `${picked}.${tail}`;
  if (ask.recommends.intent === intent) return `${picked}, as recommended.${tail}`;
  return `${picked}, not the recommended option.${tail}`;
}

/** The line of an open ask that got no answer in this Send. */
export function openLine(ask: Pick<AnsweredAsk, "id" | "title">): string {
  return `${head(ask)} no answer yet, it stays open.`;
}

/**
 * The whole message: the marked answers in the order given, then the session's other open asks (those not
 * answered here) in the order given. An ask named in `answers` is left out of `open`.
 */
export function answersMessage(answers: readonly MarkedAnswer[], open: readonly Pick<AnsweredAsk, "id" | "title">[] = []): string {
  const answered = new Set(answers.map((answer) => answer.ask.id));
  return [...answers.map(answerLine), ...open.filter((ask) => !answered.has(ask.id)).map(openLine)].join("\n");
}

/** The message's length as WalkyTalky counts it: code points. */
export function answersMessageLength(message: string): number {
  return [...message].length;
}

/** How many characters the message is over {@link HILL_ANSWERS_MESSAGE_MAX}; 0 when it fits. */
export function answersMessageOver(message: string): number {
  return Math.max(0, answersMessageLength(message) - HILL_ANSWERS_MESSAGE_MAX);
}

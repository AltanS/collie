// OmO's built-in ask-user overlay, not pi's optional `question` extension.
// ASK_NOTES.md records the captured screen and the digit-only submission probe.
import { lineText, type StyledLine } from "../../blocks";
import type { PromptModel, PromptOption } from "../prompt-model";
import { tailRule } from "./composer";

const TITLE = /^ Ask user(?: · (?:\d+m|\d{2}:\d{2}))?$/;
const RULE = /^─{8,}$/;
const SINGLE_HINTS =
  "↑↓ move  1-9 select  space select  enter next  tab next question  c comment  esc cancel";
const MULTI_HINTS =
  "↑↓ move  1-9 select  space toggle  enter toggle  tab next / Submit  c comment  esc cancel";
const EDITOR_HINTS =
  "enter save and next  ↑↓ back to options  tab next question  esc discard";
const OPTION = /^ (→ | {2})([1-9])\. (\S.*)$/;
const DESCRIPTION = /^ {6}(\S.*)$/;

interface AskFrame {
  readonly top: number;
  readonly bottom: number;
  readonly title: number;
  readonly footer: number;
  readonly texts: readonly string[];
}

function askFrame(lines: StyledLine[]): AskFrame | null {
  const tail = tailRule(lines);
  if (tail === null) return null;
  const texts = lines.map((line) => lineText(line).trimEnd());
  const footer = tail.bottom - 2;
  if (texts[tail.bottom - 1] !== "" || footer < 5) return null;
  let top = footer - 1;
  while (top >= 0 && !RULE.test(texts[top] ?? "")) {
    if (footer - top > 200) return null;
    top--;
  }
  if (top < 0 || texts[top + 1] !== "" || !TITLE.test(texts[top + 2] ?? "")) {
    return null;
  }
  return { top, bottom: tail.bottom, title: top + 2, footer, texts };
}

/** Positive evidence for the captured options and Other-editor screens only. */
export function askModalOnScreen(lines: StyledLine[]): boolean {
  const frame = askFrame(lines);
  if (frame === null) return false;
  const hints = frame.texts[frame.footer]?.trim();
  return hints === SINGLE_HINTS || hints === MULTI_HINTS || hints === EDITOR_HINTS;
}

export interface AskSelectRegion {
  readonly startLine: number;
  readonly endLine: number;
  readonly model: PromptModel;
}

/** One unanswered question, single-select, with the keyboard on an option. */
export function detectAskSelectRegion(lines: StyledLine[]): AskSelectRegion | null {
  const frame = askFrame(lines);
  if (frame === null) return null;
  const { texts, title, footer, top, bottom } = frame;
  if (texts[footer]?.trim() !== SINGLE_HINTS) return null;
  if (texts[footer - 1] !== " Submit (0/1 answered) — Enter advances") return null;
  // One question chip and Submit, not a questionnaire or its review tab.
  if (!/^ → \S(?:\S| \S)* {4}Submit$/.test(texts[title + 1] ?? "")) return null;

  let row = title + 2;
  const question: string[] = [];
  while (row < footer - 2 && !OPTION.test(texts[row] ?? "")) {
    const text = texts[row];
    if (text === undefined || !/^ \S/.test(text) || question.length === 4) return null;
    question.push(text.trim());
    row++;
  }
  if (question.length === 0) return null;

  const options: PromptOption[] = [];
  let pointed = 0;
  while (row < footer - 2) {
    const match = OPTION.exec(texts[row] ?? "");
    if (match === null) break;
    const [, pointer, digit, label] = match;
    if (digit !== String(options.length + 1) || label === undefined || label.endsWith(" ✓")) {
      return null;
    }
    if (pointer === "→ ") pointed++;
    row++;
    const description: string[] = [];
    while (row < footer - 2) {
      const detail = DESCRIPTION.exec(texts[row] ?? "");
      if (detail === null) break;
      const text = detail[1];
      if (text === undefined) return null;
      description.push(text);
      row++;
    }
    // The public tool requires descriptions; a clipped option is not a whole option.
    if (description.length === 0 || digit === undefined) return null;
    options.push({ label, description: description.join(" "), keys: [digit] });
  }
  // Other is a field, not a digit option. Its focused/editor states remain raw.
  if (options.length < 2 || pointed !== 1 || texts[row] !== "   Type your own answer...") {
    return null;
  }
  if (row + 1 !== footer - 1) return null;
  const signature = texts.slice(top, bottom + 1).join("\n");
  if (signature.length > 32_000) return null;
  options.push({ label: "Cancel", keys: ["Escape"], keyLabel: "Esc" });
  return {
    startLine: top,
    endLine: bottom + 1,
    model: {
      question: question.join(" "),
      family: "select",
      options,
      signature,
      coreSignature: signature,
    },
  };
}

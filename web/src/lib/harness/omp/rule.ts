// OMP 18.1.10's `rule` composer, rendered by pi-tui's components/composer/rule.ts:
//
//   ─────────────── <optional right status chip> ─
//   ❯ <first draft row>
//     <wrapped continuation rows>
//
//    <standalone left status row>
//
// Unlike the boxed shape, it has no closing border to use as a unique anchor. The scanner therefore
// claims only the renderer's complete tail choreography: top rule directly adjacent to the prompt,
// bounded two-space continuations, exactly one blank gap, then exactly one status row at the buffer
// tail. Content below the status or a box/modal in place of that tail makes the whole match fail.

import type { StyledLine } from "../../blocks";
import { draftGhost, isBlank, lineText, rstrip } from "./markers";

const RULE_TOP = /^─(?:[\s\S]*─)?$/;
const RULE_PROMPT = /^❯(?: ([\s\S]*))?$/;
const RULE_CONTINUATION = /^ {2}([\s\S]*\S)$/;
const MAX_DRAFT_ROWS = 100;

export interface RuleComposer {
  top: number;
  promptStart: number;
  promptEnd: number;
  status: number;
}

/** Locate OMP 18's `rule` composer at the buffer tail, or null. */
export function locateRuleComposer(lines: StyledLine[]): RuleComposer | null {
  let status = lines.length - 1;
  while (status >= 0 && isBlank(lineText(lines[status]!))) status--;
  if (status < 3 || !isBlank(lineText(lines[status - 1]!))) return null;

  const promptEnd = status - 2;
  let promptStart = promptEnd;
  let continuationRows = 0;
  while (
    promptStart >= 0 &&
    RULE_CONTINUATION.test(rstrip(lineText(lines[promptStart]!)))
  ) {
    continuationRows++;
    if (continuationRows > MAX_DRAFT_ROWS) return null;
    promptStart--;
  }

  const top = promptStart - 1;
  if (
    promptStart < 1 ||
    !RULE_PROMPT.test(rstrip(lineText(lines[promptStart]!))) ||
    !RULE_TOP.test(rstrip(lineText(lines[top]!)))
  ) {
    return null;
  }

  return { top, promptStart, promptEnd, status };
}

export function stripRuleChrome(lines: StyledLine[], composer: RuleComposer): StyledLine[] {
  let end = composer.top;
  while (end > 0 && isBlank(lineText(lines[end - 1]!))) end--;
  return lines.slice(0, end);
}

export function extractRuleStatusLines(
  lines: StyledLine[],
  composer: RuleComposer,
): StyledLine[] {
  return [lines[composer.status]!];
}

export function extractRuleInputDraft(
  lines: StyledLine[],
  composer: RuleComposer,
): string | null {
  const parts: string[] = [];
  for (let row = composer.promptStart; row <= composer.promptEnd; row++) {
    const text = rstrip(lineText(lines[row]!));
    const match =
      row === composer.promptStart ? RULE_PROMPT.exec(text) : RULE_CONTINUATION.exec(text);
    if (match === null) return null;
    parts.push(match[1] ?? "");
  }

  const last = parts.length - 1;
  const tail = parts[last]!;
  const ghost = draftGhost(lines[composer.promptEnd]!, 2, 2 + tail.length);
  if (ghost.length > 0 && tail.endsWith(ghost)) parts[last] = tail.slice(0, -ghost.length);

  const draft = parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ");
  return draft.length === 0 ? null : draft;
}

export function ruleComposerPrompt(lines: StyledLine[], composer: RuleComposer): string {
  return lines
    .slice(composer.promptStart, composer.promptEnd + 1)
    .map((line) => rstrip(lineText(line)))
    .join("\n");
}

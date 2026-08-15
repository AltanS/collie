import type { StyledLine } from "../../blocks";
import { isBlank, isBoxBorder, lineText } from "./markers";

const MAX_DRAFT_LINES = 100;
const PROMPT_REGEX = /^(?:[❯›>]\s*|\?\s*|\$\s*)/;

export interface LocatedBox {
  top: number;
  prompt: number;
  bottom: number;
  draft: string | null;
}

export function locateInputBox(texts: string[], end: number): LocatedBox | null {
  if (end === 0) return null;
  let bot = end - 1;
  while (bot >= 0 && isBlank(texts[bot]!)) bot--;
  if (bot < 0) return null;

  if (isBoxBorder(texts[bot]!)) {
    let p = bot - 1;
    let walk = 0;
    while (p >= 0 && walk < MAX_DRAFT_LINES) {
      const t = texts[p]!;
      if (PROMPT_REGEX.test(t)) {
        let top = p - 1;
        while (top >= 0 && isBlank(texts[top]!)) top--;
        if (top >= 0 && isBoxBorder(texts[top]!)) {
          const draft = t.replace(PROMPT_REGEX, "").trim() || null;
          return { top, prompt: p, bottom: bot, draft };
        }
      }
      p--;
      walk++;
    }
  }

  if (PROMPT_REGEX.test(texts[bot]!)) {
    const draft = texts[bot]!.replace(PROMPT_REGEX, "").trim() || null;
    return { top: bot, prompt: bot, bottom: bot, draft };
  }

  return null;
}

export function stripChrome(lines: StyledLine[]): StyledLine[] {
  const texts = lines.map(lineText);
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return lines.slice(0, 0);

  const box = locateInputBox(texts, end);
  if (box !== null) {
    end = box.top;
    while (end > 0 && isBlank(texts[end - 1]!)) end--;
  }

  return end === lines.length ? lines : lines.slice(0, end);
}

export function extractStatusLines(_lines: StyledLine[]): StyledLine[] {
  return [];
}

export function extractInputDraft(lines: StyledLine[]): string | null {
  const texts = lines.map(lineText);
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return null;
  const box = locateInputBox(texts, end);
  return box?.draft ?? null;
}

export function hasInputBox(lines: StyledLine[]): boolean {
  const texts = lines.map(lineText);
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return false;
  return locateInputBox(texts, end) !== null;
}

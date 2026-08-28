import type { StyledLine } from "../../blocks";
import {
  classifyFooter,
  isAlienBuffer,
  isBlank,
  isHorizontalRule,
  isMultiStepHeader,
  lineText,
} from "./markers";
import type { PromptFamily, PromptModel, PromptOption } from "../prompt-model";

export type { PromptFamily, PromptModel, PromptOption };

const SIGNATURE_LOOKBACK = 40;

export function regionSignature(texts: string[], from: number, footer: number): string {
  return texts.slice(Math.max(0, from), footer + 1).join("\n");
}

// Matches:
// "1. Label", "1) Label", "[1] Label", "(1) Label", "1: Label"
// "❯ 1. Label", "> 1. Label", "› 1. Label", "• 1. Label", "* 1. Label"
// "( ) 1. Label", "(*) 1. Label", "(•) 1. Label"
// "[ ] 1. Label", "[x] 1. Label", "[X] 1. Label", "[✔] 1. Label"
// "● 1. Label", "○ 1. Label"
const OPTION_ROW =
  /^(?:[❯›>•*○●]\s*|\([ xX*•]\)\s*|\[[ xX*•✔✓]\]\s*)?(?:(\d+)[.):\]]|\((\d+)\)|\[(\d+)\])\s+(.+)$/;

interface OptionRow {
  index: number;
  n: number;
  label: string;
}

export function parseOptionRow(text: string, isTrust?: boolean): { n: number; label: string } | null {
  const trimmed = text.trim();
  const m = OPTION_ROW.exec(trimmed);
  if (m) {
    const numStr = m[1] ?? m[2] ?? m[3];
    if (numStr) return { n: Number(numStr), label: m[4]!.trim() };
  }
  if (isTrust) {
    const tm = /^(?:[❯›>•*○●]\s*)?((?:Yes|No)[^.]*)$/i.exec(trimmed);
    if (tm) {
      const isYes = /^yes/i.test(tm[1]!);
      return { n: isYes ? 1 : 2, label: tm[1]!.trim() };
    }
  }
  return null;
}

export function trailingMenuRows<T extends { n: number }>(rows: T[]): T[] {
  if (rows.length === 0) return [];
  let s = rows.length - 1;
  while (s > 0 && rows[s - 1]!.n === rows[s]!.n - 1) s--;
  return rows[s]!.n === 1 ? rows.slice(s) : [];
}

export function isFreeTextLabel(label: string): boolean {
  return (
    /^type something\b/i.test(label) ||
    /^type a custom\b/i.test(label) ||
    /^write-in\b/i.test(label) ||
    /^tell agy\b/i.test(label) ||
    /^custom response\b/i.test(label)
  );
}

const OPTION_SCAN_WINDOW = 24;
const MAX_FOOTER_GAP = 3;
const QUESTION_SCAN_LIMIT = 12;

export interface PromptRegion {
  model: PromptModel;
  startLine: number;
}

export function coreRegionSignature(texts: string[], from: number, footer: number): string {
  const start = Math.max(0, from);
  const out: string[] = [];
  for (let i = start; i <= footer; i++) {
    out.push(texts[i]!.replaceAll("❯", " ").trimEnd());
  }
  return out.join("\n");
}

export function detectPromptSelectRegion(lines: StyledLine[]): PromptRegion | null {
  const texts = lines.map(lineText);
  if (isAlienBuffer(texts)) return null;

  // 1. Scan up from the end through any bottom status line (e.g. "esc to cancel ... Gemini ...") for the dialog footer.
  let fi = texts.length - 1;
  while (fi >= 0 && isBlank(texts[fi]!)) fi--;
  if (fi < 0) return null;

  let family = classifyFooter(texts[fi]!);
  if (!family && fi > 0) {
    const candidate = classifyFooter(texts[fi - 1]!);
    if (candidate) {
      family = candidate;
      fi = fi - 1;
    }
  }
  if (!family) return null;

  const footerIndex = fi;

  // 2. Numbered option rows just above the footer.
  const from = Math.max(0, fi - OPTION_SCAN_WINDOW);
  const rows: OptionRow[] = [];
  for (let i = from; i < fi; i++) {
    const parsed = parseOptionRow(texts[i]!, family === "trust");
    if (parsed) rows.push({ index: i, n: parsed.n, label: parsed.label });
  }

  if (rows.length < 2) return null;
  const menu = trailingMenuRows(rows);
  if (menu.length < 2) return null;
  if (menu.length > 9) return null;

  const firstOpt = menu[0]!.index;
  const lastOpt = menu[menu.length - 1]!.index;

  if (footerIndex - lastOpt > MAX_FOOTER_GAP) return null;

  const top = Math.max(0, firstOpt - QUESTION_SCAN_LIMIT);
  for (let i = top; i < footerIndex; i++) {
    if (isMultiStepHeader(texts[i]!)) return null;
  }

  // 3. Scan upward for question
  let question = "";
  let questionAt = firstOpt;
  for (let i = firstOpt - 1, seen = 0; i >= 0 && seen < QUESTION_SCAN_LIMIT; i--, seen++) {
    const t = texts[i]!;
    if (isHorizontalRule(t)) {
      if (question) break;
      continue;
    }
    if (
      t.includes("?") ||
      /^Do you\b/i.test(t.trim()) ||
      /^Question\s+\d/i.test(t.trim()) ||
      /^Requesting permission\b/i.test(t.trim())
    ) {
      question = t.trim();
      questionAt = i;
      break;
    }
  }
  if (!question) {
    for (let i = firstOpt - 1; i >= Math.max(0, firstOpt - 3); i--) {
      const prev = texts[i]!.trim();
      if (prev && !isHorizontalRule(prev)) {
        question = prev;
        questionAt = i;
        break;
      }
    }
  }
  if (!question) return null;

  const options: PromptOption[] = [];
  for (let r = 0; r < menu.length; r++) {
    const row = menu[r]!;
    if (isFreeTextLabel(row.label)) continue;
    const nextIdx = r + 1 < menu.length ? menu[r + 1]!.index : footerIndex;
    const desc: string[] = [];
    for (let i = row.index + 1; i < nextIdx; i++) {
      const t = texts[i]!;
      if (isBlank(t) || isHorizontalRule(t) || parseOptionRow(t, family === "trust")) continue;
      desc.push(t.trim());
    }
    options.push({
      label: row.label,
      description: desc.length ? desc.join(" ") : undefined,
      keys:
        family === "select" || family === "plan"
          ? [String(row.n), "Enter"]
          : [String(row.n)],
    });
  }
  if (options.length === 0) return null;

  const signature = regionSignature(texts, firstOpt - SIGNATURE_LOOKBACK, footerIndex);
  const coreSignature = coreRegionSignature(texts, questionAt, footerIndex);
  return { model: { question, options, family, signature, coreSignature }, startLine: firstOpt };
}

export function detectPromptSelect(lines: StyledLine[]): PromptModel | null {
  return detectPromptSelectRegion(lines)?.model ?? null;
}

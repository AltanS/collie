import { isBlank, lineText } from "../../blocks";
import { CLAUDE_RULE_GLYPH_CLASS } from "../../rule-glyphs";
import { displayWidth } from "../../text-width";
import type { PromptFamily } from "../prompt-model";

export { isBlank, lineText };

const RULE_ONLY = new RegExp(`^[${CLAUDE_RULE_GLYPH_CLASS}]+$`);

export function isHorizontalRule(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  return compact.length >= 3 && RULE_ONLY.test(compact);
}

const BARE_BORDER_MIN = 8;
const BARE_BORDER = /^[─━═-]+$/;
const LABELLED_BORDER = /^[─━═-]{2,}\s+(.+)\s+[─━═-]{2,}$/;
const RULE_OR_SPACE_ONLY = new RegExp(`^[${CLAUDE_RULE_GLYPH_CLASS}\\s]*$`);

export function isBoxBorder(text: string): boolean {
  const trimmed = text.trim();
  if (displayWidth(trimmed) < BARE_BORDER_MIN) return false;
  if (BARE_BORDER.test(trimmed)) return true;
  const m = LABELLED_BORDER.exec(trimmed);
  if (m === null) return false;
  return !RULE_OR_SPACE_ONLY.test(m[1]!);
}

const STEP_GLYPH = /[☐☒☑✔✅]/g;

export function isMultiStepHeader(text: string): boolean {
  const m = text.match(STEP_GLYPH);
  return m !== null && m.length >= 2;
}

export type { PromptFamily };

export function classifyFooter(text: string): PromptFamily | null {
  const t = text.toLowerCase();
  if (/\benter to select\b/.test(t) || /\bto select\b/.test(t) || /\bpress enter\b/.test(t)) return "select";
  if (/\benter to confirm\b/.test(t) || /\bconfirm\b/.test(t)) return "trust";
  if (/\bplan\b/.test(t)) return "plan";
  if (/\btab to amend\b/.test(t) || /\bproceed\b/.test(t) || /\by\/n\b/.test(t) || /\bpermission\b/.test(t) || /\ballow\b/.test(t)) return "permission";
  return null;
}

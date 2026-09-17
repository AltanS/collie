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
  if (/\b(?:enter\s+confirm|enter\s+to\s+confirm)\b/.test(t)) return "trust";
  if (/\b(?:tab\s+amend|tab\s+to\s+amend)\b/.test(t)) return "permission";
  if (/\bctrl\+r\s+review\b/.test(t) && !/\btab\s+amend\b/.test(t)) return "plan";
  if (/ctrl\+g\s+to\s+edit\b/.test(t) || /\.antigravity\/plans\//.test(t) || /\.agy\/plans\//.test(t)) return "plan";
  if (/\b(?:enter\s+select|enter\s+to\s+select)\b/.test(t)) return "select";
  return null;
}

// The name markers that say "this buffer belongs to another agent". Each one is a PHRASE Claude
// paints itself, never the bare word: an agy pane whose conversation merely mentions Claude, with
// neither "agy" nor "Antigravity" on the visible screen, must not be read as alien — its dialog
// would stall.
//
// "tell Claude" is the phrase a permission dialog paints in its own option row ("No, and tell Claude
// what to do differently"), and it is the only Claude name on a permission screen whose welcome
// banner has scrolled off. The capture lab (2026-09-17) showed how thin that cover is: every older
// Claude capture cleared this guard on the banner alone, and the lab's 82-column Edit-permission
// screens name Claude NOWHERE — not in a banner, and not in an option row, because their third
// option is a bare "No". agy's prompt-select lifts their numbered options, and no wider name list
// fixes it. Those two captures are therefore not in fixtures/panes; see its README for the record.
export function isAlienBuffer(texts: string[]): boolean {
  for (const text of texts) {
    if (/Claude Code|\.claude\/|Claude Sonnet|Claude Opus|Claude Max|tell Claude|AskUserQuestion/i.test(text)) {
      const full = texts.join(" ");
      if (!/Antigravity CLI|\.antigravity|agy/i.test(full)) return true;
    }
    if (/╭─ Ask ─╮|oh-my-pi|codex|grok/i.test(text)) return true;
  }
  return false;
}


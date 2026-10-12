// The pi editor frame, in the two layouts Herdr reports as `pi`:
//   OmO 5.1.30 (pi--omo-v5130-idle.txt, -draft.txt): rule, a column-zero `❯` row with two-space
//   continuations, rule, then 1–3 styled status rows.
//   Stock pi 0.85.1 (pi--v0851-idle.txt, -draft.txt): rule, the draft at column zero with no glyph,
//   rule, then styled status rows.
// While a turn runs the top rule carries a label (`── ⠴ Working ───`, pi--v085-working-editor.txt).
// Questions replace the editor between the rules; a status tail alone never permits typing.
import { lineText, type StyledLine } from "../../blocks";

const RULE = /^─{8,}$/;
/** The top rule, bare or carrying a turn label such as `── ⠴ Working ───`. */
const TOP_RULE = /^(?:─{8,}|── \S.*? ─{8,})$/;
const PROMPT = /^❯(?: ([\s\S]*))?$/;
const CONTINUATION = /^ {2}([\s\S]*)$/;
const BOX_EDGE = /^[\u2500-\u257f]/;
const MAX_EDITOR_ROWS = 100;

function text(line: StyledLine): string {
  return lineText(line).trimEnd();
}

function ruleColor(line: StyledLine): string | undefined {
  return line.segments.find((segment) => segment.text.trim() !== "")?.fg;
}

function styled(line: StyledLine): boolean {
  return line.segments.some((s) => s.text.trim() !== "" && (s.fg !== undefined || s.muted));
}

/** end is exclusive and omits only blank terminal padding after the status tail. */
export function tailRule(lines: StyledLine[]): { bottom: number; end: number } | null {
  let end = lines.length;
  while (end > 0) {
    const last = lines[end - 1];
    if (last === undefined) return null;
    if (text(last) !== "") break;
    end--;
  }
  for (let bottom = end - 2; bottom >= Math.max(0, end - 4); bottom--) {
    const bottomLine = lines[bottom];
    if (bottomLine === undefined || !RULE.test(text(bottomLine))) continue;
    const footer = lines.slice(bottom + 1, end);
    const unknown = footer.some((line) => {
      const value = text(line);
      return value === "" || BOX_EDGE.test(value.trimStart()) || PROMPT.test(value) || !styled(line);
    });
    return unknown ? null : { bottom, end };
  }
  return null;
}

export interface PiComposer {
  readonly layout: "omo" | "stock";
  readonly top: number;
  readonly bottom: number;
  readonly end: number;
}

export function locateComposer(lines: StyledLine[]): PiComposer | null {
  const tail = tailRule(lines);
  if (tail === null) return null;
  const { bottom, end } = tail;
  const bottomLine = lines[bottom];
  if (bottomLine === undefined) return null;
  let top = bottom - 1;
  while (top >= 0) {
    const line = lines[top];
    if (line === undefined) return null;
    if (TOP_RULE.test(text(line))) break;
    if (bottom - top > MAX_EDITOR_ROWS) return null;
    top--;
  }
  const topLine = lines[top];
  if (top < 0 || topLine === undefined || top + 1 === bottom) return null;
  if (ruleColor(topLine) !== ruleColor(bottomLine)) return null;
  const rows = lines.slice(top + 1, bottom);
  const first = rows[0];
  if (first === undefined) return null;
  if (PROMPT.test(text(first))) {
    // OmO: the prompt glyph wears the rules' colour, and every later row is a two-space continuation.
    if (ruleColor(bottomLine) === undefined || ruleColor(first) !== ruleColor(bottomLine)) return null;
    const ok = rows.slice(1).every((row) => {
      const value = text(row);
      return value === "" || (CONTINUATION.test(value) && !BOX_EDGE.test(value.trimStart()));
    });
    return ok ? { layout: "omo", top, bottom, end } : null;
  }
  // Stock pi: the draft starts at column zero. A row opening with a space or a box glyph is a
  // panel drawn between the rules (OmO's Ask dialog opens every row with a space), never a draft.
  const ok = rows.every((row) => {
    const value = text(row);
    return value === "" || (!value.startsWith(" ") && !BOX_EDGE.test(value) && !PROMPT.test(value));
  });
  return ok ? { layout: "stock", top, bottom, end } : null;
}

export function composerDraft(lines: StyledLine[]): string | null {
  const composer = locateComposer(lines);
  if (composer === null) return null;
  const draft = lines.slice(composer.top + 1, composer.bottom)
    .map((line, index) => {
      const value = text(line);
      if (composer.layout === "stock") return value;
      return index === 0 ? (PROMPT.exec(value)?.[1] ?? "") : value.slice(2);
    })
    .join(" ").trim();
  return draft || null;
}

/** Bind clearing to the exact editor frame, not changing status counters below it. */
export function composerPrompt(lines: StyledLine[]): string | null {
  const composer = locateComposer(lines);
  return composer === null ? null : lines.slice(composer.top, composer.bottom + 1)
    .map(text).join("\n");
}

export function composerStatusLines(lines: StyledLine[]): StyledLine[] {
  const tail = tailRule(lines);
  return tail === null ? [] : lines.slice(tail.bottom + 1, tail.end);
}

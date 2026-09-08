import type { StyledLine } from "../../blocks";
import { draftGhost, lineText, opensBox, rstrip } from "./markers";

export interface PiComposer {
  top: number;
  firstDraftRow: number;
  bottom: number;
  suggestEnd: number;
  layout: "pi";
}

// Captured with OMP 18.1.13, composer.shape=pi (2026-09-07): two coloured
// rules enclose indented draft rows; the status line lives BELOW the editor.
// Match the whole tail, not an arbitrary pair of transcript separators. Unknown
// footer layouts and overlays remain unrecognised rather than authorising Enter.
export function locatePiComposer(lines: StyledLine[]): PiComposer | null {
  const texts = lines.map((line) => rstrip(lineText(line)));
  let end = texts.length;
  while (end > 0 && texts[end - 1] === "") end--;
  let bottom = end - 2;
  for (; bottom >= Math.max(0, end - 5); bottom--) {
    if (/^─{8,}$/.test(texts[bottom]!)) break;
  }
  if (bottom < 2 || bottom < end - 5) return null;
  const footer = lines.slice(bottom + 1, end);
  const status = footer[0];
  if (!status || !/^\s+\S/.test(lineText(status))) return null;
  // Status fields are styled and contain the configured separator. A plain
  // transcript following two rules is not evidence of a live editor.
  if (!status.segments.some((s) => s.fg && /[·/|]/.test(s.text))) return null;
  if (footer.some((line) => opensBox(lineText(line)) || !lineText(line).trim())) return null;
  if (footer.slice(1).some((line) => !/^(?:\s+\S|[○●] )/.test(lineText(line)))) return null;
  const borderColor = lines[bottom]!.segments.find((s) => s.text.trim())?.fg;
  if (!borderColor) return null;
  let top = bottom - 1;
  for (; top >= Math.max(0, bottom - 101); top--) {
    if (/^─{8,}$/.test(texts[top]!)) break;
    if (texts[top] !== "" && !texts[top]!.startsWith(" ")) return null;
  }
  if (top < 0 || bottom - top > 101 || bottom - top < 2) return null;
  if (texts[top] !== texts[bottom]) return null;
  if (lines[top]!.segments.find((s) => s.text.trim())?.fg !== borderColor) return null;
  return { top, firstDraftRow: top + 1, bottom, suggestEnd: end, layout: "pi" };
}

export function piDraft(lines: StyledLine[], box: PiComposer): string | null {
  const draft = lines.slice(box.firstDraftRow, box.bottom)
    .map((line, i) => {
      const text = rstrip(lineText(line));
      const ghost = box.firstDraftRow + i === box.bottom - 1 ? draftGhost(line, 1, text.length) : "";
      return text.slice(1, ghost ? text.length - ghost.length : undefined).trimEnd();
    }).join(" ").trim();
  return draft || null;
}

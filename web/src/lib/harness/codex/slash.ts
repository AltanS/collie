// Codex slash commands temporarily replace the ordinary prompt/status tail with a filtered command
// palette. A guarded reply that just typed `/status` therefore cannot use locateComposer: the status
// row is intentionally gone, even though the exact text is still visible and Enter would submit the
// selected command. This classifier accepts only the renderer-owned exact-command state: a
// background-painted `› /command` input, its lower background row, and a first cyan/bold option whose
// command equals the complete query. Partial filters and arbitrary prompt-shaped transcript prose
// stay fail-closed.

import type { AnsiSegment } from "../../ansi";
import type { StyledLine } from "../../blocks";
import { isBlank, lastNonBlankIndex, lineText, promptText, rstrip } from "./markers";

const COMMAND = /^\/[a-z][a-z0-9_-]{0,63}$/;
const OPTION = /^ {2}\/[a-z][a-z0-9_-]{0,63} {2,}\S.{0,480}$/;
const MAX_OPTIONS = 12;
const MAX_TRAILING_BLANKS = 2;

export interface SlashPalette {
  promptRow: number;
  lastOptionRow: number;
  command: string;
}

function unstyled(segment: AnsiSegment): boolean {
  return (
    segment.fg === undefined &&
    segment.bg === undefined &&
    segment.bold !== true &&
    segment.dim !== true &&
    segment.italic !== true &&
    segment.underline !== true &&
    segment.strike !== true
  );
}

function backgroundBlank(line: StyledLine, background: string): boolean {
  return (
    isBlank(lineText(line)) &&
    line.segments.length > 0 &&
    line.segments.every((segment) => segment.bg === background)
  );
}

function promptCommand(line: StyledLine): { command: string; background: string } | null {
  const command = promptText(rstrip(lineText(line)));
  if (command === null || !COMMAND.test(command) || line.segments.length !== 2) return null;
  const [marker, body] = line.segments;
  if (
    marker?.text !== "›" ||
    marker.bg === undefined ||
    marker.bold !== true ||
    marker.dim === true ||
    body === undefined ||
    body.bg !== marker.bg ||
    body.bold === true ||
    body.dim === true ||
    rstrip(body.text) !== ` ${command}`
  ) {
    return null;
  }
  return { command, background: marker.bg };
}

function selectedExactOption(line: StyledLine, command: string): boolean {
  if (line.segments.length !== 2) return false;
  const [indent, selected] = line.segments;
  if (
    indent?.text !== "  " ||
    !unstyled(indent) ||
    selected === undefined ||
    selected.fg === undefined ||
    selected.bg !== undefined ||
    selected.bold !== true ||
    selected.dim === true
  ) {
    return false;
  }
  return new RegExp(`^${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} {2,}\\S`).test(
    rstrip(selected.text),
  );
}

/** Exact slash palette at the buffer tail, or null. Pure; no pane access. */
export function locateSlashPalette(lines: StyledLine[]): SlashPalette | null {
  const texts = lines.map((line) => rstrip(lineText(line)));
  const last = lastNonBlankIndex(texts);
  if (last < 3 || lines.length - 1 - last > MAX_TRAILING_BLANKS) return null;

  const firstCandidate = Math.max(1, last - MAX_OPTIONS - 1);
  for (let promptRow = last - 2; promptRow >= firstCandidate; promptRow--) {
    const prompt = promptCommand(lines[promptRow]!);
    if (prompt === null) continue;
    if (!backgroundBlank(lines[promptRow - 1]!, prompt.background)) continue;
    if (!backgroundBlank(lines[promptRow + 1]!, prompt.background)) continue;

    const firstOption = promptRow + 2;
    const optionCount = last - firstOption + 1;
    if (optionCount < 1 || optionCount > MAX_OPTIONS) continue;
    if (!selectedExactOption(lines[firstOption]!, prompt.command)) continue;
    if (!texts.slice(firstOption, last + 1).every((text) => OPTION.test(text))) continue;
    return { promptRow, lastOptionRow: last, command: prompt.command };
  }
  return null;
}

export function slashInputDraft(lines: StyledLine[]): string | null {
  return locateSlashPalette(lines)?.command ?? null;
}

export function slashComposerReady(lines: StyledLine[]): boolean {
  return locateSlashPalette(lines) !== null;
}

export function slashPromptRegion(lines: StyledLine[]): string | null {
  const palette = locateSlashPalette(lines);
  if (palette === null) return null;
  return lines
    .slice(palette.promptRow, palette.lastOptionRow + 1)
    .map((line) => rstrip(lineText(line)))
    .join("\n");
}

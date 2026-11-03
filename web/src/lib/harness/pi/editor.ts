import { lineText, type StyledLine } from "../../blocks";
import { canonicalStyledLines, encodeStyledRegion } from "../../styled-region";
import type { DialogEditorObservation } from "../editor-model";
import { piEditorOwner, readPiFrame } from "./ask";

/** Default-Pi native inputs in the outside-footer questionnaire shape. Complete bounds and a real
 * reverse-video cell are required; displayed wraps never become logical newlines here. */
export function observePiEditor(lines: StyledLine[]): DialogEditorObservation | null {
  const frame = readPiFrame(lines);
  if (frame?.bodyEnd === undefined || frame.open || !frame.footer.arrowsMove || frame.footer.enter !== "select") return null;
  const ownerSignature = piEditorOwner(lines, frame);
  if (ownerSignature === null) return null;
  const width = frame.texts[frame.top]!.length;
  const fullRule = (text: string) => text === "─".repeat(width);
  const note = frame.texts.findLastIndex((text, row) => row > frame.top && row < frame.bodyEnd! &&
    /^ (Notes|Global note):$/.test(text) && lines[row]!.segments.some((segment) => segment.fg !== undefined && segment.text.trim() !== ""));
  const layout = note >= 0 ? "boxed" : "inline";
  const purpose = layout === "boxed" ? (frame.texts[note]!.trim() === "Global note:" ? "global-note" : "question-note") : "answer";
  let start = -1;
  let end = -1;
  let indent = 0;
  if (layout === "boxed") {
    if (!fullRule(frame.texts[note + 1]!)) return null;
    start = note + 2;
    end = frame.texts.findIndex((text, row) => row > start && row < frame.bodyEnd! && fullRule(text));
    // The default Editor reserves a cursor column: a value row cannot be its full-width border.
    if (frame.texts.slice(start, end).some((text) => text.length === width && text.startsWith("─") && /[↑↓]/.test(text))) return null;
  } else {
    const prefix = frame.footer.spaceToggles ? /^([❯ ]) ([1-9]\d*)\. \[[ ✔✓x]\] / : /^([❯ ]) ([1-9]\d*)\. /;
    let focused = false;
    for (let row = frame.top + 1; row < frame.bodyEnd; row++) {
      const match = prefix.exec(lineText(lines[row]!));
      if (match !== null) { start = row; indent = match[0].length; focused = match[1] === "❯"; }
    }
    if (!focused) return null;
    if (frame.footer.spaceToggles) end = frame.texts.findIndex((text, row) => row > start && row < frame.bodyEnd! && /^  (Next|Submit)$/.test(text));
    else {
      // selectedText styles the continuation PREFIX too: even an empty logical row has bold
      // indent cells. The dialog's trailing spacer/padding is unpainted, so it is not input.
      end = start + 1;
      while (end < frame.bodyEnd && lineText(lines[end]!).slice(0, indent).trim() === "" &&
        lines[end]!.segments.some((segment) => segment.bold)) end++;
      if (frame.texts.slice(end, frame.bodyEnd).some((text) => text !== "" && !text.startsWith(" Note for this answer: "))) return null;
    }
  }
  if (start < 0 || end <= start) return null;
  const rows: string[] = [];
  let cursor: DialogEditorObservation["cursor"] | null = null;
  for (let row = start; row < end; row++) {
    const text = lineText(lines[row]!);
    if (layout === "inline" && row > start && text.slice(0, indent).trim() !== "") return null;
    let offset = 0;
    let ownedEnd = 0;
    for (const segment of lines[row]!.segments) {
      if (segment.bg !== undefined) {
        if (cursor !== null || offset < indent) return null;
        cursor = { row: row - start, offset: offset - indent, cell: segment.text };
      }
      offset += segment.text.length;
      if (segment.bold || segment.bg !== undefined) ownedEnd = offset;
    }
    rows.push(layout === "boxed" ? text.trimEnd() : text.slice(indent, ownedEnd));
  }
  if (cursor === null) return null;
  if (layout === "boxed") {
    const text = lineText(lines[start + cursor.row]!);
    rows[cursor.row] = text.slice(0, Math.max(text.trimEnd().length, cursor.offset + cursor.cell.length));
  }
  const region = lines.slice(frame.top, frame.bottom + 1);
  const fixedRows = [...lines.slice(frame.top, start), ...lines.slice(end, frame.bottom + 1)]
    .filter((line) => lineText(line).trim() !== ""); // layout padding can change with a cursor-only row
  const contextSignature = JSON.stringify([encodeStyledRegion(canonicalStyledLines(fixedRows)),
    layout === "inline" ? lineText(lines[start]!).slice(0, indent) : ""]);
  return {
    purpose, layout, ownerSignature, contextSignature, rows, cursor,
    regionSignature: region.map((line) => lineText(line).trimEnd()).join("\n"),
    styledSignature: encodeStyledRegion(canonicalStyledLines(region)),
    // Measured against default Pi bindings in @juicesharp/rpiv-ask-user-question 2.15.0.
    keys: { start: ["ctrl+a"], end: ["ctrl+e"], up: ["Up"], left: ["Left"], right: ["Right"] },
  };
}

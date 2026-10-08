import type { StyledLine } from "../../blocks";
import type { PromptModel, PromptOption } from "../prompt-model";
import { pointerWalk } from "../menu-hints";
import { locateComposer } from "./chrome";
import { composerPromptText, lineText, regionSignature, rstrip } from "./markers";

export interface ModelPickerRegion {
  model: PromptModel;
  startLine: number;
}

const MODEL_NAME = String.raw`Grok \d+(?:\.\d+)+(?: Fast)?`;
const MODEL_COMMAND = /^\/model(?: <model> \[window\] \[effort\])?$/;
const WINDOW_COMMAND = new RegExp(String.raw`^/model ${MODEL_NAME}$`);
const EFFORT_COMMAND = new RegExp(String.raw`^/model ${MODEL_NAME} \d+[km]$`);
const MODEL_ROW = new RegExp(String.raw`^(${MODEL_NAME}(?: \(current\))?)(?:\s+([\s\S]+))?$`);
const WINDOW_ROW = /^(\d+[km](?: \(active\))?)(?:\s+([\s\S]+))?$/;
const EFFORT_ROW = /^((?:Extra High|High|Medium|Low)(?: \(active\))?)(?:\s+([\s\S]+))?$/;
const PICKER_TOP = /^\s*─+(\d+)─$/;
const PICKER_BOTTOM = /^\s*─+$/;

// Enter does something different at each of the three stages, so only the complete layouts measured
// in MODEL_PICKER_NOTES.md are taken. Any other command's completion list is not a menu to submit,
// and the stages are never chained into one unverified run of Enters.
export function detectModelPickerRegion(lines: StyledLine[]): ModelPickerRegion | null {
  const box = locateComposer(lines);
  if (box === null || box.bottom !== box.top + 2) return null;
  const command = composerPromptText(lineText(lines[box.firstDraftRow]!))?.trim();
  if (command === undefined) return null;
  const rowPattern = MODEL_COMMAND.test(command)
    ? MODEL_ROW
    : WINDOW_COMMAND.test(command)
      ? WINDOW_ROW
      : EFFORT_COMMAND.test(command)
        ? EFFORT_ROW
        : null;
  if (rowPattern === null) return null;
  const texts = lines.map((line) => rstrip(lineText(line)));
  if (!/(?:^|\s)Enter:send(?:\s|$)/.test(texts[box.hintEnd - 1]!)) return null;
  const bottom = box.top - 1;
  if (bottom < 0 || !PICKER_BOTTOM.test(texts[bottom]!)) return null;

  const rows: { label: string; description: string; pointed: boolean }[] = [];
  let start = bottom - 1;
  for (; start >= 0; start--) {
    const text = texts[start]!;
    const top = PICKER_TOP.exec(text);
    if (top !== null) {
      if (Number(top[1]) !== rows.length) return null;
      break;
    }
    const body = text.trimStart();
    const pointed = body.startsWith("❯ ");
    const row = rowPattern.exec(pointed ? body.slice(2) : body);
    if (row === null) return null;
    rows.unshift({ label: row[1]!, description: row[2] ?? "", pointed });
  }
  if (start < 0 || rows.length === 0 || rows.filter((row) => row.pointed).length !== 1) return null;
  if (new Set(rows.map((row) => row.label)).size !== rows.length) return null;
  const pointed = rows.findIndex((row) => row.pointed);
  const options: PromptOption[] = rows.map((row, index) => {
    const option: PromptOption = { label: row.label, keys: pointerWalk(pointed, index) };
    if (row.description !== "") option.description = row.description;
    return option;
  });
  options.push({ label: "Ctrl+C", keys: ["ctrl+c"], keyLabel: "Ctrl+C" });
  const signature = regionSignature(lines, start, box.hintEnd);
  const coreSignature = texts.slice(start, box.hintEnd).map((text, index) => {
    if (index > 0 && index <= rows.length) return text.replace(/^(\s*)❯ /, "$1  ");
    return text;
  }).join("\n");
  return {
    startLine: start,
    model: {
      question: command,
      caption: "/model",
      family: "select",
      options,
      signature,
      coreSignature,
    },
  };
}

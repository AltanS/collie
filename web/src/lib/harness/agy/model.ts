import { lineText, type StyledLine } from "../../blocks";
import type { MenuModel } from "../menu-model";
import { regionSignature } from "./prompt-select";

export interface ModelRegion {
  model: MenuModel;
  startLine: number;
  statusStartLine?: number;
}

const MODEL_KEYBOARD =
  /^Keyboard: ↑\/↓ Navigate(?: ←\/→ Effort)?(?: tab Context)? enter Select(?: esc (?:Go Back|Clear search))?$/i;
const MODEL_CONT =
  /^\s+(?:(?:↑\/↓ Navigate|←\/→ Effort|tab Context|enter Select|esc (?:Go Back|Clear search))\s*)+$/i;

const EFFORT_KEYBOARD = /^Keyboard: (?:←\/→ Effort enter Select(?: esc Go Back)?|esc Go Back)$/i;
const EFFORT_CONT = /^\s+(?:(?:←\/→ Effort|enter Select|esc Go Back)\s*)+$/i;
const EFFORT_TRACK = /[●◉○][━─]{4,}[●◉○]/;

const PROMPTS_FOR_A_KEY = /\b(?:press|hit)\s+\S+\s+to\b|\[y\/n\]|\(y\/n\)/i;
const STATUS =
  /^(?:\s{8,}\S.* · \S+|\S+\s+(?:idle|reviewing|error|working|thinking|authenticating|merging|waiting|done)\s+\S.*|\S+(?: \S+)*\s{2,}(?:(?:auto|default|accept-edits|plan|fast|custom)\s{2,})?(?:idle|reviewing|error|working|thinking|tool_use|initializing|authenticating|merging|waiting|done)(?:\s{2,}\S.*)?)$/;

/** The native model (`/model`) and effort (`/effort`) menus, including wrapped or clipped footers. */
export function detectModelRegion(lines: StyledLine[]): ModelRegion | null {
  return detectSwitchModelRegion(lines) ?? detectEffortSelectorRegion(lines);
}

function detectSwitchModelRegion(lines: StyledLine[]): ModelRegion | null {
  const texts = lines.map(lineText);
  let end = texts.length - 1;
  while (end >= 0 && texts[end]!.trim() === "") end--;
  let keyboard = end;
  while (keyboard >= 0 && end - keyboard < 8 && !/^Keyboard:\s/.test(texts[keyboard]!)) keyboard--;
  if (keyboard < 0 || !/^Keyboard:\s/.test(texts[keyboard]!)) return null;

  let footerEnd = keyboard;
  while (footerEnd + 1 <= end && MODEL_CONT.test(texts[footerEnd + 1] ?? "")) {
    footerEnd++;
  }
  const footer = texts.slice(keyboard, footerEnd + 1).join(" ").replace(/\s+/g, " ").trim();
  if (!MODEL_KEYBOARD.test(footer)) return null;
  const tail = texts.slice(footerEnd + 1, end + 1).filter((row) => row.trim() !== "");
  if (tail.length > 2 || tail.some((row) => !STATUS.test(row))) return null;

  let top = keyboard - 1;
  while (top >= 0 && keyboard - top < 60 && texts[top]!.trim() !== "Switch Model") top--;
  if (top < 0 || texts[top]!.trim() !== "Switch Model") return null;
  const body = texts.slice(top + 1, keyboard);
  if (!body.some((row) => /^\s*Search:/.test(row)) || body.filter((row) => /^> \S/.test(row)).length !== 1) return null;
  if (body.some((row) => PROMPTS_FOR_A_KEY.test(row))) return null;

  const nav: MenuModel["nav"] = { upDown: true };
  const effort = body.findIndex((row) => /^\s*Effort\s/.test(row));
  if (effort >= 0 && /←\/→ Effort/i.test(footer)) {
    for (const line of lines.slice(top + effort + 2, keyboard)) {
      const labels = line.segments.filter((segment) => segment.bold && segment.text.trim() !== "");
      if (labels.length === 1) {
        nav.leftRight = { verb: "Effort", label: labels[0]!.text.trim() };
        break;
      }
    }
  }
  const actions: MenuModel["actions"] = [{ label: "Select", keys: ["Enter"] }];
  if (/esc Clear search/i.test(footer)) {
    actions.push({ label: "Clear search", keys: ["Escape"], cancel: true });
  } else if (/esc Go Back/i.test(footer)) {
    actions.push({ label: "Go back", keys: ["Escape"], cancel: true });
  }
  return {
    startLine: top,
    statusStartLine: footerEnd + 1 < lines.length ? footerEnd + 1 : undefined,
    model: { title: "Switch Model", nav, actions, signature: regionSignature(texts, top, end) },
  };
}

function detectEffortSelectorRegion(lines: StyledLine[]): ModelRegion | null {
  const texts = lines.map(lineText);
  let end = texts.length - 1;
  while (end >= 0 && texts[end]!.trim() === "") end--;
  let keyboard = end;
  while (keyboard >= 0 && end - keyboard < 8 && !/^Keyboard:\s/.test(texts[keyboard]!)) keyboard--;
  if (keyboard < 0 || !/^Keyboard:\s/.test(texts[keyboard]!)) return null;

  let footerEnd = keyboard;
  while (footerEnd + 1 <= end && EFFORT_CONT.test(texts[footerEnd + 1] ?? "")) {
    footerEnd++;
  }
  const footer = texts.slice(keyboard, footerEnd + 1).join(" ").replace(/\s+/g, " ").trim();
  if (!EFFORT_KEYBOARD.test(footer)) return null;
  const tail = texts.slice(footerEnd + 1, end + 1).filter((row) => row.trim() !== "");
  if (tail.length > 2 || tail.some((row) => !STATUS.test(row))) return null;

  let top = keyboard - 1;
  while (top >= 0 && keyboard - top < 24 && texts[top]!.trim() !== "Set Effort") top--;
  if (top < 0 || texts[top]!.trim() !== "Set Effort") return null;
  const body = texts.slice(top + 1, keyboard);
  if (body.some((row) => PROMPTS_FOR_A_KEY.test(row))) return null;

  const nav: MenuModel["nav"] = { upDown: false };
  const actions: MenuModel["actions"] = [];

  if (/←\/→ Effort/i.test(footer)) {
    const trackIdx = body.findIndex((row) => EFFORT_TRACK.test(row));
    if (trackIdx < 0) return null;
    for (let i = top + 1 + trackIdx + 1; i < keyboard; i++) {
      const rowText = texts[i]!.trim();
      if (rowText === "") continue;
      const values = rowText.split(/\s+/);
      const boldSegments = lines[i]!.segments.filter((s) => s.bold && s.text.trim() !== "");
      if (values.length >= 2 && values.every((v) => /^[a-z0-9_-]+$/i.test(v)) && boldSegments.length === 1) {
        const active = boldSegments[0]!.text.trim();
        if (values.includes(active)) {
          nav.leftRight = { verb: "Effort", label: active, values };
        }
      }
      break;
    }
    actions.push({ label: "Select", keys: ["Enter"] });
    if (/esc Go Back/i.test(footer)) {
      actions.push({ label: "Go back", keys: ["Escape"], cancel: true });
    }
  } else {
    if (!body.some((row) => /Effort isn't adjustable for the current model/i.test(row))) return null;
    actions.push({ label: "Go back", keys: ["Escape"], cancel: true });
  }

  return {
    startLine: top,
    statusStartLine: footerEnd + 1 < lines.length ? footerEnd + 1 : undefined,
    model: { title: "Set Effort", nav, actions, signature: regionSignature(texts, top, end) },
  };
}

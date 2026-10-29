// The `/artifact` review and viewer screens in Antigravity CLI 1.4.7 / 1.4.8 (live 2026-10-24):
//
// 1. `ArtifactViewModel` (list & review picker, opened by `/artifact`):
//    - Review mode (`Action required (N left)`):
//      Each actionable artifact row shows its review state (`□ new`, `✓ approved`, `✗ rejected`),
//      the artifact filename, and the inline action bar `open  approve reject` on the highlighted
//      (`› `) row. Pressing `p` expands an inline `│ ...` markdown preview below the row. Pressing
//      `Escape` after staging partial decisions enters the confirm-exit state (`Submit  Dismiss`),
//      where `ArtifactViewModel.Update` ignores Up/Down/y/n/p and only accepts Tab/Left/Right,
//      Enter, and Escape.
//    - Browse mode (`Artifacts`, when no artifact awaits review):
//      Each artifact row shows its filename and `open` on the highlighted (`› `) row, with `p`
//      toggling the inline preview and `Enter` opening `ArtifactDetailModel`.
//
// 2. `ArtifactDetailModel` (full-viewport markdown viewer, opened by `Enter` on `open`):
//    - Normal document view: header ` <filename> [pct%]`, numbered lines with `>` on the cursor
//      line, and a 2- or 3-row `·`-separated footer (`c comment · ctrl+g editor · t outline ·
//      l hide/show lines · / search · g/G top/bottom · ctrl+u/ctrl+d half page · esc close`).
//    - Outline view (`t`): header ` <filename> — Outline`, heading list (`> H1 ...`), and footer
//      `↑/↓ navigate · enter jump · t back`.
//    - Unsent-comments confirmation (`esc` when comments were added): footer
//      `You have N unsent comment(s). Send to agent?` / `y send + close · n discard + close · esc cancel`.
//
// Both lift as a generic `menu` (`MenuModel`), emitting only keys verified against the 1.4.7 binary
// and live Herdr session (`Up`/`Down`, `y`, `n`, `p`, `t`, `l`, `Tab`, `Enter`, `Escape`).
import { lineText, type StyledLine } from "../../blocks";
import type { MenuAction, MenuModel } from "../menu-model";
import { isBoxBorder } from "./markers";
import { regionSignature } from "./prompt-select";

export interface ArtifactRegion {
  model: MenuModel;
  startLine: number;
  statusStartLine?: number;
}

const REVIEW_TITLE = /^Action required(?:\s+\(\d+\s+left\))?\s*$/;
const LIST_TITLE = /^Artifacts\s*$/;

const REVIEW_POINTER = /^›\s+(?:□ new|✓ approved|✗ rejected)\s+\S.*?\s+open\s+approve\s+reject\s*$/;
const LIST_POINTER = /^›\s+\S.*?\s+open\s*$/;
const CONFIRM_EXIT = /^(\s{2,3})Submit(\s{1,2})Dismiss\s*$/;

const KEYBOARD = /^Keyboard:\s/;
const ESC_LIST_FOOTER = /(?:^\s*|\s{2,}|Keyboard:\s+)esc (?:Done|save & dismiss|Dismiss)\s*$/;

const DETAIL_HEADER = /^ (\S+\.\w+)(?:\s+\(\d+ comments?\))?(?:\s+—\s+(Outline))?(?:\s+\[\d+%\])?\s*$/;
const DETAIL_CLOSE = /^\s*(?:l (?:hide|show) lines · \/ search · g\/G top\/bottom · )?ctrl\+u\/ctrl\+d half page · esc close\s*$/;
const DETAIL_COMMENT_HEAD = /^\s*c comment · ctrl\+g editor · t outline\b/;
const OUTLINE_FOOTER = /^\s*↑\/↓ navigate · enter jump · t back\s*$/;
const UNSENT_PROMPT = /^\s*You have \d+ unsent comment\(s\)\. Send to agent\?\s*$/;
const UNSENT_FOOTER = /^\s*y send \+ close · n discard \+ close · esc cancel\s*$/;

const STATUS =
  /^(?:\s{8,}\S+(?: \S+)* · \S+\s*|\S+\s+(?:idle|reviewing|error|working|thinking|authenticating|merging|waiting|done)\s+\S.*|\S+(?: \S+)*\s{2,}(?:(?:auto|default|accept-edits|plan|fast|custom)\s{2,})?(?:idle|reviewing|error|working|thinking|tool_use|initializing|authenticating|merging|waiting|done)(?:\s{2,}\S.*)?)$/;
const NAMES_A_KEY = /\b(?:enter|esc(?:ape)?|space|tab|ctrl\+\S+|y\/n)\b/i;
const PROMPTS_FOR_A_KEY = /\b(?:press|hit)\s+\S+\s+to\b|\[y\/n\]|\(y\/n\)/i;

const STATUS_ROWS = 2;
const FOOTER_ROWS = 3;
const TITLE_SCAN_ROWS = 40;

export function detectArtifactRegion(lines: StyledLine[]): ArtifactRegion | null {
  const texts = lines.map((l) => lineText(l).trimEnd());
  return detectArtifactListRegion(texts) ?? detectArtifactDetailRegion(texts);
}

function detectArtifactListRegion(texts: string[]): ArtifactRegion | null {
  let last = texts.length - 1;
  while (last >= 0 && texts[last]!.trim() === "") last--;
  if (last < 0) return null;

  let escRow = -1;
  let seen = 0;
  for (let i = last; i >= 0 && seen <= STATUS_ROWS; i--) {
    if (texts[i]!.trim() === "") continue;
    if (ESC_LIST_FOOTER.test(texts[i]!)) {
      escRow = i;
      break;
    }
    if (i === last && !STATUS.test(texts[i]!)) return null;
    if (NAMES_A_KEY.test(texts[i]!)) return null;
    seen++;
  }
  if (escRow < 0) return null;

  let keyboard = -1;
  for (let i = escRow; i >= 0 && escRow - i <= FOOTER_ROWS; i--) {
    if (KEYBOARD.test(texts[i]!)) {
      keyboard = i;
      break;
    }
    if (i < escRow && !/^\s{2,}\S/.test(texts[i]!)) return null;
  }
  if (keyboard < 0) return null;

  const footer = texts
    .slice(keyboard, escRow + 1)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  let top = -1;
  let isReview = false;
  for (let i = keyboard - 1; i >= 0 && keyboard - i <= TITLE_SCAN_ROWS; i--) {
    const row = texts[i]!;
    if (isBoxBorder(row)) break;
    if (REVIEW_TITLE.test(row)) {
      top = i;
      isReview = true;
      break;
    }
    if (LIST_TITLE.test(row)) {
      top = i;
      isReview = false;
      break;
    }
  }
  if (top < 0) return null;

  const body = texts.slice(top + 1, keyboard);
  if (body.some((row) => PROMPTS_FOR_A_KEY.test(row) || isBoxBorder(row))) return null;

  const pointed = body.filter((row) => /^›\s/.test(row));
  const emptyList = !isReview && pointed.length === 0 && body.some((row) => /^\s*No artifacts\b/i.test(row));
  if (pointed.length !== 1 && !emptyList) return null;
  const pointedRow = pointed[0] ?? "";

  let actions: MenuAction[];
  let upDown = !emptyList;

  if (isReview) {
    if (!REVIEW_POINTER.test(pointedRow)) return null;
    if (
      !footer.includes("↑/↓ Navigate") ||
      !footer.includes("y/n Approve/reject") ||
      !/\bp Preview\b/i.test(footer) ||
      (!footer.includes("esc Done") && !footer.includes("esc save & dismiss"))
    ) {
      return null;
    }

    const confirmRow = body.map((row) => CONFIRM_EXIT.exec(row)).find((m) => m !== null) ?? null;
    if (confirmRow !== null) {
      upDown = false;
      const submitFocused = confirmRow[1] === "   ";
      actions = [
        { label: "Submit", keys: submitFocused ? ["Enter"] : ["Tab", "Enter"] },
        { label: "Dismiss", keys: ["Escape"], cancel: true },
      ];
    } else {
      const openFocused = /\s{3}open\s{2}approve\s+reject\s*$/.test(pointedRow);
      actions = [
        { label: "Approve", keys: ["y"] },
        { label: "Reject", keys: ["n"] },
        { label: "Preview", keys: ["p"] },
        { label: openFocused ? "Open" : "Select", keys: ["Enter"] },
        {
          label: footer.includes("esc save & dismiss") ? "Save & dismiss" : "Done",
          keys: ["Escape"],
          cancel: true,
        },
      ];
    }
  } else {
    if (!emptyList && !LIST_POINTER.test(pointedRow)) return null;
    if (
      !footer.includes("↑/↓ Navigate") ||
      !/\bp preview\b/i.test(footer) ||
      !footer.includes("enter open") ||
      !footer.includes("esc Dismiss")
    ) {
      return null;
    }
    actions = emptyList
      ? [{ label: "Dismiss", keys: ["Escape"], cancel: true }]
      : [
          { label: "Preview", keys: ["p"] },
          { label: "Open", keys: ["Enter"] },
          { label: "Dismiss", keys: ["Escape"], cancel: true },
        ];
  }

  const signature = regionSignature(texts, top, last);
  if (signature === "") return null;
  const result: ArtifactRegion = {
    model: {
      title: texts[top]!.trim(),
      actions,
      nav: { upDown },
      signature,
    },
    startLine: top,
  };
  if (escRow < last && STATUS.test(texts[last]!)) {
    result.statusStartLine = last;
  }
  return result;
}

function detectArtifactDetailRegion(texts: string[]): ArtifactRegion | null {
  let top = 0;
  while (top < texts.length && texts[top]!.trim() === "") top++;
  let last = texts.length - 1;
  while (last >= 0 && texts[last]!.trim() === "") last--;
  if (top >= last) return null;

  const headerMatch = DETAIL_HEADER.exec(texts[top]!);
  if (headerMatch === null) return null;
  const fileName = headerMatch[1]!;
  const isOutlineHeader = headerMatch[2] === "Outline";

  let footerEnd = -1;
  let footerKind: "read" | "outline" | "unsent" | null = null;
  let seen = 0;
  for (let i = last; i > top && seen <= STATUS_ROWS; i--) {
    if (texts[i]!.trim() === "") continue;
    if (DETAIL_CLOSE.test(texts[i]!)) {
      footerEnd = i;
      footerKind = "read";
      break;
    }
    if (OUTLINE_FOOTER.test(texts[i]!)) {
      footerEnd = i;
      footerKind = "outline";
      break;
    }
    if (UNSENT_FOOTER.test(texts[i]!)) {
      footerEnd = i;
      footerKind = "unsent";
      break;
    }
    if (i === last && !STATUS.test(texts[i]!)) return null;
    if (NAMES_A_KEY.test(texts[i]!)) return null;
    seen++;
  }
  if (footerEnd < 0 || footerKind === null) return null;

  let footerStart = footerEnd;
  let actions: MenuAction[];
  let upDown = true;
  let title = fileName;

  if (footerKind === "outline") {
    if (!isOutlineHeader) return null;
    const body = texts.slice(top + 1, footerStart);
    if (body.some((row) => PROMPTS_FOR_A_KEY.test(row) || isBoxBorder(row))) return null;
    if (!body.some((row) => /^>\s+H\d\s+\S/.test(row))) return null;
    title = `${fileName} — Outline`;
    actions = [
      { label: "Jump", keys: ["Enter"] },
      { label: "Back", keys: ["Escape"], cancel: true },
    ];
  } else if (footerKind === "unsent") {
    if (footerEnd - 1 <= top || !UNSENT_PROMPT.test(texts[footerEnd - 1]!)) return null;
    footerStart = footerEnd - 1;
    const body = texts.slice(top + 1, footerStart);
    if (body.some((row) => isBoxBorder(row))) return null;
    upDown = false;
    actions = [
      { label: "Send & close", keys: ["y"] },
      { label: "Discard & close", keys: ["n"] },
      { label: "Cancel", keys: ["Escape"], cancel: true },
    ];
  } else {
    if (isOutlineHeader) return null;
    let headRow = -1;
    for (let i = footerEnd - 1; i > top && footerEnd - i <= FOOTER_ROWS; i--) {
      if (DETAIL_COMMENT_HEAD.test(texts[i]!)) {
        headRow = i;
        break;
      }
      if (!/^\s{2,}\S/.test(texts[i]!)) return null;
    }
    if (headRow < 0) return null;
    footerStart = headRow;
    const joinedFooter = texts
      .slice(footerStart, footerEnd + 1)
      .join(" · ")
      .replace(/\s+/g, " ")
      .trim();
    if (!joinedFooter.includes("l hide lines") && !joinedFooter.includes("l show lines")) return null;
    const body = texts.slice(top + 1, footerStart);
    if (body.some((row) => PROMPTS_FOR_A_KEY.test(row) || isBoxBorder(row))) return null;
    if (!body.some((row) => /^(?:>| )\s*\d+(?:\s|$)/.test(row) || /^>\s/.test(row))) return null;
    actions = [
      { label: "Outline", keys: ["t"] },
      { label: joinedFooter.includes("l show lines") ? "Show lines" : "Hide lines", keys: ["l"] },
      { label: "Close", keys: ["Escape"], cancel: true },
    ];
  }

  const signature = regionSignature(texts, top, last);
  if (signature === "") return null;
  const result: ArtifactRegion = {
    model: {
      title,
      actions,
      nav: { upDown },
      signature,
    },
    startLine: top,
  };
  if (footerEnd < last && STATUS.test(texts[last]!)) {
    result.statusStartLine = last;
  }
  return result;
}

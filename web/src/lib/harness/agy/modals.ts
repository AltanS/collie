// Native `Keyboard:` and `scrollPanel` modals in Antigravity CLI 1.4.7 / 1.4.8 (live 2026-10-27):
//
//   - `/rewind`      (`RewindModel`      — `Rewind Conversation`)
//   - `/agents`      (`AgentsModel`      — `Available Agents`)
//   - `/skills`      (`SkillsModel`      — `Skills`)
//   - `/tasks`       (`TasksModel`       — `Tasks` / `Task Details`)
//   - `/mcp`         (`MCPModel`         — `MCP Servers`)
//   - `/settings`    (`SettingsModel`    — `Settings`)
//   - `/permissions` (`PermissionsModel` — `Permission Config Editor` / `Permissions — ...`)
//   - `/usage`       (`UsageModel`       — `└ Models & Quota`)
//   - `/context`     (`ContextModel`     — `└ Context Usage`)
import { lineText, type StyledLine } from "../../blocks";
import type { MenuAction, MenuModel } from "../menu-model";
import { isBoxBorder } from "./markers";
import { regionSignature } from "./prompt-select";

export interface AgyModalRegion {
  model: MenuModel;
  startLine: number;
  statusStartLine?: number;
}

const KEYBOARD = /^Keyboard:\s/;
const SCROLL_PANEL_CLOSE =
  /^\s{2,}(?:(?:↑\/↓ Scroll|pgup\/pgdown Page|ctrl\+end Bottom|ctrl\+home Top)\s*·\s*)*esc Close\s*$/i;
const SCROLL_PANEL_CONT =
  /^\s{2,}(?:↑\/↓ Scroll|pgup\/pgdown Page|ctrl\+end Bottom|ctrl\+home Top)(?:\s*·\s*(?:pgup\/pgdown Page|ctrl\+end Bottom|ctrl\+home Top))*\s*$/i;
const SCROLL_PANEL_FOOTER =
  /^(?:↑\/↓ Scroll · pgup\/pgdown Page · ctrl\+end Bottom · ctrl\+home Top · )?esc Close$/i;
const SCROLL_PANEL_STATUS_ROWS = 2;
const SCROLL_PANEL_FOOTER_ROWS = 3;
const POINTER = /^>\s+\S/;
const SEARCH_RULE = /^\s{10,}─{10,}$/;
const PROMPTS_FOR_A_KEY = /\b(?:press|hit)\s+\S+\s+to\b|\[y\/n\]|\(y\/n\)/i;
const NAMES_A_KEY = /\b(?:enter|esc(?:ape)?|space|tab|ctrl\+\S+|y\/n)\b/i;
const STATUS =
  /^(?:\s{8,}\S.* · \S+|\S+\s+(?:idle|reviewing|error|working|thinking|authenticating|merging|waiting|done)\s+\S.*|\S+(?: \S+)*\s{2,}(?:(?:auto|default|accept-edits|plan|fast|custom)\s{2,})?(?:idle|reviewing|error|working|thinking|tool_use|initializing|authenticating|merging|waiting|done)(?:\s{2,}\S.*)?)$/;

const TITLE_SCAN_ROWS = 45;

interface ModalSpec {
  matchTopHeading: (trimmed: string) => string | null;
  matchRegion: (regionRows: string[]) => boolean;
  matchFooter: (footer: string) => boolean;
  canNavigate?: (regionRows: string[], footer: string, hasPointer: boolean) => boolean;
  leftRight?: (regionRows: string[], footer: string, navigable: boolean) => MenuModel["nav"]["leftRight"];
  buildActions: (footer: string, navigable: boolean) => MenuAction[];
}

const MODAL_SPECS: readonly ModalSpec[] = [
  {
    matchTopHeading: (t) => (t === "Rewind Conversation" ? t : null),
    matchRegion: (rows) =>
      rows.slice(1).some((r) => POINTER.test(r) || /No user messages to rewind to\./i.test(r)),
    matchFooter: (f) => /^Keyboard:\s+.*\besc (?:Cancel|Go Back)\b/i.test(f),
    buildActions: (f, navigable) => [
      ...(navigable && /\benter Select\b/i.test(f) ? [{ label: "Select", keys: ["Enter"] }] : []),
      { label: /\besc Go Back\b/i.test(f) ? "Go back" : "Cancel", keys: ["Escape"], cancel: true },
    ],
  },
  {
    matchTopHeading: (t) =>
      t === "Create New Agents" || t === "Available Agents" ? "Available Agents" : null,
    matchRegion: (rows) =>
      rows.some((r) => r.trim() === "Available Agents") &&
      rows.some((r) =>
        POINTER.test(r) ||
        /^\s*(?:Global:|Workspace:|Subagents\b|\[ Loading agents\.\.\. \])/.test(r),
      ),
    matchFooter: (f) => /^Keyboard:\s+.*\besc (?:Go Back|Cancel)\b/i.test(f),
    buildActions: (f, navigable) => [
      ...(navigable && /\benter Select\b/i.test(f) ? [{ label: "Select", keys: ["Enter"] }] : []),
      { label: "Go back", keys: ["Escape"], cancel: true },
    ],
  },
  {
    matchTopHeading: (t) =>
      t === "Create new skills" || /^Skills(?:\s+\(\d+\s+skills?\))?$/.test(t) ? "Skills" : null,
    matchRegion: (rows) =>
      rows.some((r) => /^Skills(?:\s+\(\d+\s+skills?\))?$/.test(r.trim())) &&
      rows.some((r) =>
        POINTER.test(r) || /^\s*(?:Global:|Built-in:|Workspace:|Shared:|No skills found\.)/.test(r),
      ),
    matchFooter: (f) => /^Keyboard:\s+.*\besc (?:Cancel|Go Back)\b/i.test(f),
    canNavigate: (rows, f, hasPointer) =>
      hasPointer ||
      (/↑\/↓ Navigate\b/i.test(f) && !rows.some((r) => /^\s*No skills found\./i.test(r))),
    buildActions: (f, navigable) => [
      ...(navigable && /\benter View\b/i.test(f) ? [{ label: "View", keys: ["Enter"] }] : []),
      { label: /\besc Go Back\b/i.test(f) ? "Go back" : "Cancel", keys: ["Escape"], cancel: true },
    ],
  },
  {
    matchTopHeading: (t) => (t === "Tasks" || t === "Task Details" ? t : null),
    matchRegion: (rows) =>
      rows.slice(1).some((r) => POINTER.test(r) || /^\s*(?:No background tasks\b|Command:\s|Status:\s)/.test(r)),
    matchFooter: (f) =>
      /^Keyboard:\s+.*(?:\benter View output\b|\bk Kill Task\b|\bx Remove Task From List\b|\besc (?:Go Back|Cancel|Close)\b)/i.test(
        f,
      ),
    buildActions: (f, navigable) => [
      ...(navigable && /\benter View output\b/i.test(f)
        ? [{ label: "View output", keys: ["Enter"] }]
        : []),
      { label: /\besc Go Back\b/i.test(f) ? "Go back" : "Close", keys: ["Escape"], cancel: true },
    ],
  },
  {
    matchTopHeading: (t) => (t === "MCP Servers" ? t : null),
    matchRegion: (rows) =>
      rows.slice(1).some((r) => POINTER.test(r) || /^\s*No MCP servers configured\./.test(r)),
    matchFooter: (f) => /^Keyboard:\s+.*\besc (?:Exit|Back|Go Back|Cancel|Close)\b/i.test(f),
    buildActions: (f, navigable) => [
      ...(navigable && /\benter (?:Actions|Select)\b/i.test(f)
        ? [{ label: /\benter Actions\b/i.test(f) ? "Actions" : "Select", keys: ["Enter"] }]
        : []),
      { label: /\besc (?:Back|Go Back)\b/i.test(f) ? "Back" : "Exit", keys: ["Escape"], cancel: true },
    ],
  },
  {
    matchTopHeading: (t) => (/^Settings(?:\s+for\s+Project\s+\S.*)?$/.test(t) ? "Settings" : null),
    matchRegion: (rows) =>
      rows.slice(1).some((r) => POINTER.test(r) || /^\s*(?:Search:|To modify these settings\b)/.test(r)),
    matchFooter: (f) => /^Keyboard:\s+.*\besc (?:Clear Search\/Exit|Exit|Go Back|Cancel|Close)\b/i.test(f),
    canNavigate: (_rows, f, hasPointer) => hasPointer || /↑\/↓ Navigate\b/i.test(f),
    leftRight: (rows, f, navigable) => {
      if (!navigable || !/←\/→ Change\b/i.test(f)) return undefined;
      const pointed = rows.find((r) => POINTER.test(r));
      const val = pointed ? /^>\s+\S+(?: \S+)*\s{2,}(\S(?:.*\S)?)$/.exec(pointed.trimEnd())?.[1] : undefined;
      return { verb: "Change", label: val ?? "Change" };
    },
    buildActions: (f, navigable) => [
      ...(navigable && /\benter (?:Select|Toggle|Edit)\b/i.test(f)
        ? [{ label: "Select", keys: ["Enter"] }]
        : []),
      { label: "Exit", keys: ["Escape"], cancel: true },
    ],
  },
  {
    matchTopHeading: (t) =>
      t === "Permission Config Editor" || /^Permissions\s+—\s+\S.*$/.test(t) ? t : null,
    matchRegion: (rows) =>
      rows.slice(1).some((r) =>
        POINTER.test(r) || /^\s*(?:Select a config scope to edit:|Rules:|Hooks:|No .* rules\.)/.test(r),
      ),
    matchFooter: (f) => /^Keyboard:\s+.*\besc (?:Close|Back|Cancel|Go Back)\b/i.test(f),
    canNavigate: (_rows, f, hasPointer) => hasPointer || /↑\/↓ Navigate\b/i.test(f),
    buildActions: (f, navigable) => [
      ...(navigable && /\benter (?:Select|Save)\b/i.test(f)
        ? [{ label: /\benter Save\b/i.test(f) ? "Save" : "Select", keys: ["Enter"] }]
        : []),
      { label: /\besc Back\b/i.test(f) ? "Back" : "Close", keys: ["Escape"], cancel: true },
    ],
  },
];

export function detectAgyModalRegion(lines: StyledLine[]): AgyModalRegion | null {
  const texts = lines.map((l) => lineText(l).trimEnd());
  let end = texts.length - 1;
  while (end >= 0 && texts[end]!.trim() === "") end--;
  if (end < 0) return null;

  return detectKeyboardModalRegion(lines, texts, end) ?? detectScrollPanelRegion(lines, texts, end);
}

function detectKeyboardModalRegion(
  lines: StyledLine[],
  texts: string[],
  end: number,
): AgyModalRegion | null {
  let keyboard = end;
  while (keyboard >= 0 && end - keyboard < 8 && !KEYBOARD.test(texts[keyboard]!)) keyboard--;
  if (keyboard < 0 || !KEYBOARD.test(texts[keyboard]!)) return null;

  let footerEnd = keyboard;
  while (footerEnd + 1 <= end) {
    const next = texts[footerEnd + 1]!;
    if (next.trim() === "" || STATUS.test(next) || isBoxBorder(next)) break;
    if (/^\s{2,}\S/.test(next) && NAMES_A_KEY.test(next) && !PROMPTS_FOR_A_KEY.test(next)) {
      footerEnd++;
      continue;
    }
    break;
  }

  const footer = texts
    .slice(keyboard, footerEnd + 1)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const tail = texts.slice(footerEnd + 1, end + 1).filter((row) => row.trim() !== "");
  if (tail.length > 2 || tail.some((row) => !STATUS.test(row))) return null;

  let scanStart = Math.max(0, keyboard - TITLE_SCAN_ROWS);
  for (let i = keyboard - 1; i >= scanStart; i--) {
    if (isBoxBorder(texts[i]!) && !SEARCH_RULE.test(texts[i]!)) {
      scanStart = i + 1;
      break;
    }
  }

  for (let i = scanStart; i < keyboard; i++) {
    const trimmed = texts[i]!.trim();
    if (trimmed === "") continue;
    for (const spec of MODAL_SPECS) {
      const title = spec.matchTopHeading(trimmed);
      if (title === null) continue;
      if (!spec.matchFooter(footer)) continue;
      const regionRows = texts.slice(i, keyboard);
      if (regionRows.slice(1).some((r) => PROMPTS_FOR_A_KEY.test(r))) return null;
      if (!spec.matchRegion(regionRows)) continue;
      const hasPointer = regionRows.slice(1).some((r) => POINTER.test(r));
      const navigable = spec.canNavigate ? spec.canNavigate(regionRows, footer, hasPointer) : hasPointer;
      const leftRight = spec.leftRight ? spec.leftRight(regionRows, footer, navigable) : undefined;
      const signature = regionSignature(texts, i, end);
      if (signature === "") return null;
      return {
        startLine: i,
        statusStartLine: footerEnd + 1 < lines.length ? footerEnd + 1 : undefined,
        model: {
          title,
          nav: { upDown: navigable, leftRight },
          actions: spec.buildActions(footer, navigable),
          signature,
        },
      };
    }
  }

  return null;
}

function detectScrollPanelRegion(
  lines: StyledLine[],
  texts: string[],
  end: number,
): AgyModalRegion | null {
  let escRow = -1;
  let seen = 0;
  for (let i = end; i >= 0 && seen <= SCROLL_PANEL_STATUS_ROWS; i--) {
    if (texts[i]!.trim() === "") continue;
    if (SCROLL_PANEL_CLOSE.test(texts[i]!)) {
      escRow = i;
      break;
    }
    if (i === end && !STATUS.test(texts[i]!)) return null;
    if (NAMES_A_KEY.test(texts[i]!)) return null;
    seen++;
  }
  if (escRow < 0) return null;

  let footerStart = escRow;
  while (footerStart - 1 >= 0 && escRow - (footerStart - 1) < SCROLL_PANEL_FOOTER_ROWS) {
    if (!SCROLL_PANEL_CONT.test(texts[footerStart - 1]!)) break;
    footerStart--;
  }

  const footer = texts
    .slice(footerStart, escRow + 1)
    .map((r) => r.trim())
    .join(" · ")
    .replace(/\s+/g, " ")
    .trim();
  if (!SCROLL_PANEL_FOOTER.test(footer)) return null;

  let scanStart = Math.max(0, footerStart - TITLE_SCAN_ROWS);
  for (let i = footerStart - 1; i >= scanStart; i--) {
    if (isBoxBorder(texts[i]!) && !SEARCH_RULE.test(texts[i]!)) {
      scanStart = i + 1;
      break;
    }
  }

  for (let i = scanStart; i < footerStart; i++) {
    const trimmed = texts[i]!.trim();
    if (trimmed !== "└ Models & Quota" && trimmed !== "└ Context Usage") continue;
    const regionRows = texts.slice(i, footerStart);
    if (regionRows.slice(1).some((r) => PROMPTS_FOR_A_KEY.test(r))) return null;
    const isUsage = trimmed === "└ Models & Quota";
    const validBody = isUsage
      ? regionRows
          .slice(1)
          .some((r) =>
            /^\s*(?:Account:\s|Models within this group:|Weekly Limit Remaining\b|Five Hour Limit Remaining\b|Quota available\b|Refreshes in\b)/.test(
              r,
            ),
          )
      : regionRows
          .slice(1)
          .some((r) =>
            /(?:Estimated usage|Free space:|User messages:|Agent responses:|Tool calls:|^Related:\s)/.test(
              r.trim(),
            ),
          );
    if (!validBody) continue;
    const signature = regionSignature(texts, i, end);
    if (signature === "") return null;
    return {
      startLine: i,
      statusStartLine: escRow + 1 < lines.length ? escRow + 1 : undefined,
      model: {
        title: isUsage ? "Models & Quota" : "Context Usage",
        nav: { upDown: /↑\/↓ Scroll\b/i.test(footer) },
        actions: [{ label: "Close", keys: ["Escape"], cancel: true }],
        signature,
      },
    };
  }

  return null;
}

import { lineText, trimTrailingBlank, type StyledLine } from "../../blocks";
import { frameRows, isDivider, lastVisibleRow, readPanelTail } from "./frame";

interface Composer {
  top: number;
  prompt: number;
  draftEnd: number;
}

const MAX_TAIL_ROWS = 40;
const MAX_STATUS_ROWS = 8;
// The V2 engine (kiro-cli 2.32.0 --v2) prints the same composer with only the copy hint.
const ACTION_HINT = /^\s*(?:\/sessions to resume · )?\/copy to clipboard$/;
const CONTEXT_GAUGE = /(?:^| · )[◷◔◑◕] \d{1,3}%(?: · | {2,}|$)/;
const PLACEHOLDER = "ask a question or describe a task ↵";

function locateComposer(lines: StyledLine[]): Composer | null {
  const rows = frameRows(lines);
  if (readPanelTail(rows) !== null) return null;
  const last = lastVisibleRow(rows);
  if (last < 0) return null;
  const end = ACTION_HINT.test(rows[last] ?? "") ? lastVisibleRow(rows.slice(0, last)) : last;
  const draftEnd = end;

  for (let prompt = end; prompt >= Math.max(0, end - MAX_TAIL_ROWS); prompt--) {
    const row = rows[prompt] ?? "";
    if (!/^›(?: |$)/.test(row)) {
      // The prompt wraps beneath its two-column prefix. No transcript, panel, or unknown
      // hint is allowed beneath it. A popup with a live composer above it is not a composer.
      if (row.trim() !== "" && !/^ {2}\S/.test(row)) return null;
      continue;
    }
    if (rows[prompt - 1]?.trim() !== "") return null;
    let top = prompt - 2;
    while (top >= 0 && !isDivider(rows[top] ?? "")) {
      if (prompt - top > MAX_STATUS_ROWS + 2 || rows[top]?.trim() === "") return null;
      top--;
    }
    if (top < 0) return null;
    const status = rows.slice(top + 1, prompt - 1);
    const [bar = "", cwdRow] = status;
    // Kiro's status bar names the agent/model, its context gauge, and the cwd. Requiring the
    // whole frame prevents an echoed › draft or the approval editor from looking typeable.
    // The cwd starts its own row, or is right-aligned on the bar's row when it fits there. A
    // right-aligned cwd can still wrap mid-path onto the row below when the bar grows.
    const cwd = / {2,}(?:\/|~\/)\S/.test(bar) || /^(?:\/|~\/)/.test(cwdRow ?? "");
    if (!bar.includes(" · ") || !CONTEXT_GAUGE.test(bar) || !cwd || status.some((text) => /^[›❯─]/.test(text))) {
      return null;
    }
    return { top, prompt, draftEnd };
  }
  return null;
}

/** Only a complete normal composer frame authorizes typing. A panel or unknown tail fails closed. */
export function composerReady(lines: StyledLine[]): boolean {
  return locateComposer(lines) !== null;
}

/** The literal prompt and draft rows to bind a destructive composer write to. */
export function composerPrompt(lines: StyledLine[]): string | null {
  const composer = locateComposer(lines);
  if (composer === null) return null;
  return lines
    .slice(composer.prompt, composer.draftEnd + 1)
    .map((line) => lineText(line).replace(/\s+$/, ""))
    .join("\n");
}

/** The normal status bar and cwd rows, with their terminal styling kept. */
export function extractStatusLines(lines: StyledLine[]): StyledLine[] {
  const composer = locateComposer(lines);
  return composer === null ? [] : lines.slice(composer.top + 1, composer.prompt - 1);
}

/** Recover a normal literal draft. Captured word-wrapped rows are joined with spaces. */
export function extractInputDraft(lines: StyledLine[]): string | null {
  const composer = locateComposer(lines);
  if (composer === null) return null;
  const rows = frameRows(lines);
  const first = (rows[composer.prompt] ?? "").slice(2).trim();
  // Kiro puts an extra space before its placeholder. A user typing the same sentence gets
  // the ordinary one-space prefix, so that draft must still be recoverable.
  if ((rows[composer.prompt] ?? "") === `›  ${PLACEHOLDER}`) return null;
  const rest = rows.slice(composer.prompt + 1, composer.draftEnd + 1).map((row) => row.trim());
  const draft = [first, ...rest].filter((row) => row !== "").join(" ");
  return draft === "" ? null : draft;
}

/** Remove only a complete normal composer; unread panels and torn frames stay visible. */
export function stripChrome(lines: StyledLine[]): StyledLine[] {
  const composer = locateComposer(lines);
  return composer === null ? lines : trimTrailingBlank(lines.slice(0, composer.top));
}

// Chrome for Kiro CLI V3's normal composer: the divider, the status bar with its context gauge and
// cwd, a blank row and the `›` prompt. The box is found by the same profile frame the bridge's Send
// Protocol reads; the status bar is what tells the composer from an echoed `›` row or a panel's editor.

import { trimTrailingBlank, type StyledLine } from "../../blocks";
import { findInputFrame, frameEdge, type Frame } from "../../surface/frame";
import { frameRows, KIRO_IDLE, readPanelTail } from "./markers";

const MAX_STATUS_ROWS = 8;
const CONTEXT_GAUGE = /(?:^| · )[◷◔◑◕] \d{1,3}%(?: · | {2,}|$)/;

/**
 * The input box, found by the profile's frame, with Kiro's status bar checked on top. The frame alone
 * also matches an echoed `›` draft under any divider and the approval editor's `›` field; only the
 * normal composer draws the bar with its context gauge between the divider and the prompt.
 */
function locateComposer(lines: StyledLine[]): Frame | null {
  const rows = frameRows(lines);
  if (readPanelTail(rows) !== null) return null;
  const frame = findInputFrame(lines, KIRO_IDLE);
  if (frame === null) return null;
  const { top, interior } = frame;
  if (rows[interior.prompt - 1]?.trim() !== "") return null;
  const status = rows.slice(top + 1, interior.prompt - 1);
  if (status.length > MAX_STATUS_ROWS || status.some((text) => text.trim() === "")) return null;
  // No status row is one of the box's own edges, or starts with the pointer a panel menu draws.
  const edgeInside = status.some((text) => frameEdge(text, KIRO_IDLE) !== null || text.startsWith("❯"));
  // The context gauge on the bar's first row is what only the normal composer draws.
  return !edgeInside && CONTEXT_GAUGE.test(status[0] ?? "") ? frame : null;
}

/** Only a complete normal composer frame authorizes typing. A panel or unknown tail fails closed. */
export function composerReady(lines: StyledLine[]): boolean {
  return locateComposer(lines) !== null;
}

/** The normal status bar and cwd rows, with their terminal styling kept. */
export function extractStatusLines(lines: StyledLine[]): StyledLine[] {
  const frame = locateComposer(lines);
  return frame === null ? [] : lines.slice(frame.top + 1, frame.interior.prompt - 1);
}

/** Recover a normal literal draft. Captured word-wrapped rows are joined with spaces. */
export function extractInputDraft(lines: StyledLine[]): string | null {
  const frame = locateComposer(lines);
  if (frame === null) return null;
  if (frame.placeholder) return null;
  return frame.interior.text === "" ? null : frame.interior.text;
}

/** Remove only a complete normal composer; unread panels and torn frames stay visible. */
export function stripChrome(lines: StyledLine[]): StyledLine[] {
  const frame = locateComposer(lines);
  return frame === null ? lines : trimTrailingBlank(lines.slice(0, frame.top));
}

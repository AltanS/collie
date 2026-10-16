// The SESSION PICKER that Codex and Muse Code both paint for `/resume` (Codex 0.159, Muse 1.4.8, live
// 2026-10-15): a `Resume a previous session` title, filter rows, one row per session with the pointer
// on the highlighted one (`›` in Codex, `⟩` in Muse), and a two-row footer of `<key> <verb>` hints
// joined by runs of spaces:
//
//   enter resume   ctrl+a archive   esc exit   ctrl+c exit   tab focus sort/filter   ←/→ change option
//   ctrl+o comfortable view   ctrl+t transcript   ctrl+e expand   ↑/↓ browse
//
// It lifts as a generic `menu` (menu-model.ts) carrying only the keys a phone may fire safely: Up and
// Down to move, Enter to resume, Escape to leave. `ctrl+a archive` takes a session away and
// `ctrl+c exit` can quit the agent, so neither becomes a button; the view toggles stay keyboard-only.
// Shared here because the two adapters paint the same picker; each passes its own pointer and its
// own region signature, so neither imports the other.
import type { MenuModel } from "./menu-model";
import { capitaliseMenuLabel } from "./menu-hints";

/** The detection result buildBlocks needs: the model plus the title row everything above stays raw. */
export interface SessionPickerRegion {
  model: MenuModel;
  startLine: number;
}

const TITLE = /^\s*Resume a previous session\s*$/;
// Each hint is a whole segment: the run of spaces (or the row's edge) on both sides is what keeps
// `enter resume` from matching inside a session's title.
const hint = (text: string) => new RegExp(String.raw`(?:^\s*|\s{2,})${text}(?=\s{2,}|\s*$)`);
const RESUME = hint("enter resume");
const EXIT = hint("esc exit");
const BROWSE = hint(String.raw`↑/↓ browse`);
// The title sits above the filter rows and at most a screenful of sessions.
const TITLE_SCAN_ROWS = 40;
// Non-blank rows above the browse row that may still belong to the footer.
const FOOTER_ROWS = 2;

/**
 * Detect the session picker at the tail of `texts`, or null. `pointer` matches the highlighted session
 * row, `signature(from, to)` is the adapter's region signature over rows `[from, to]`.
 *
 * Fail-closed: the last two non-blank rows must name `enter resume`, `esc exit` and `↑/↓ browse`, the
 * title must sit above them, and a session row must be highlighted. An empty list has no pointer, so
 * it stays raw rather than offering Resume over nothing.
 */
export function detectSessionPicker(
  texts: readonly string[],
  pointer: RegExp,
  signature: (from: number, to: number) => string,
): SessionPickerRegion | null {
  let last = texts.length - 1;
  while (last >= 0 && texts[last]!.trim() === "") last--;
  if (last < 0 || !BROWSE.test(texts[last]!)) return null;
  // The resume row is the footer's first row; a narrow pane can wrap the footer onto a third row, so
  // it may sit up to two non-blank rows above the browse row.
  let above = -1;
  let seen = 0;
  for (let i = last - 1; i >= 0 && seen < FOOTER_ROWS; i--) {
    if (texts[i]!.trim() === "") continue;
    seen++;
    if (RESUME.test(texts[i]!) && EXIT.test(texts[i]!)) {
      above = i;
      break;
    }
  }
  if (above < 0) return null;

  let top = -1;
  for (let i = above - 1; i >= 0 && above - i <= TITLE_SCAN_ROWS; i--) {
    if (TITLE.test(texts[i]!)) {
      top = i;
      break;
    }
  }
  if (top < 0) return null;
  if (!texts.slice(top + 1, above).some((row) => pointer.test(row))) return null;

  const region = signature(top, last);
  if (region === "") return null;
  return {
    model: {
      title: texts[top]!.trim(),
      actions: [
        { label: capitaliseMenuLabel("resume"), keys: ["Enter"] },
        { label: capitaliseMenuLabel("exit"), keys: ["Escape"], cancel: true },
      ],
      nav: { upDown: true },
      signature: region,
    },
    startLine: top,
  };
}

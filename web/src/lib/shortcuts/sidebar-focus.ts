// THE SIDEBAR FOCUS of Navigate mode (M108). `prefix+w` puts a ring on one row of the sidebar. The
// keys move the ring and nothing else: no route, no pane, no view changes until Enter opens the
// row, exactly as a click on it would. Esc leaves and puts the sidebar back as it was.
//
// THE ROWS ARE READ FROM THE SIDEBAR AS IT IS DRAWN, in DOM order, every time they are needed. The
// list is never kept: a filter, a fold or a status change moves rows, and a kept list would point at
// the wrong one. A row is a `data-slot="pane-row"` or `data-slot="launch-row"` of the open sidebar
// (components/agent-sidebar.tsx), so whatever the sidebar lists at that moment is what the ring walks.
//
// THE RING IS PAINTED ON THE DOM, not through props: the rows belong to the sidebar's own component,
// and a ring that lives in shortcut state must not make every row subscribe to it. The ring is
// `data-shortcut-focus` (index.css draws the outline); the sidebar's list host names the row in
// `aria-activedescendant`, so a screen reader hears the row the ring is on.
//
// The state is `sidebarFocus` in lib/shortcuts/state.ts. The mode's enter and leave come from the
// sidebar's owner (components/wide-layout.tsx), which watches the mode.

import { isSidebarOpen, setSidebarOpen } from "@/lib/wide-layout-store";

import { getSidebarFocus, publishSidebarFocus } from "./state";

const ROW_SELECTOR = '[data-slot="wide-sidebar"] [data-slot="pane-row"], [data-slot="wide-sidebar"] [data-slot="launch-row"]';
const LIST_SELECTOR = '[data-slot="sidebar-list"]';
const ROW_ID_PREFIX = "shortcut-focus-row-";

/** The sidebar opened by the mode, so the way out can close it again. */
let isOpenedByMode = false;
/** The ring was asked for while the rows were not drawn yet (the sidebar was a rail). */
let isPlacing = false;

/** The focusable rows of the open sidebar, in the order it draws them. Empty when it is a rail. */
export function sidebarRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(ROW_SELECTOR)].filter((row) => !row.hasAttribute("disabled"));
}

function currentIndex(rows: readonly HTMLElement[]): number {
  const at = rows.findIndex((row) => row.getAttribute("aria-current") === "page");
  return at < 0 ? 0 : at;
}

function clearPaint(): void {
  for (const row of document.querySelectorAll("[data-shortcut-focus]")) row.removeAttribute("data-shortcut-focus");
  for (const list of document.querySelectorAll(LIST_SELECTOR)) {
    list.removeAttribute("aria-activedescendant");
    list.removeAttribute("role");
  }
}

/** Draw the ring on the row the state names, and say so in the list's `aria-activedescendant`. */
export function paintSidebarFocus(): void {
  clearPaint();
  const focus = getSidebarFocus();
  if (focus === null) return;
  const row = sidebarRows()[focus.index];
  if (row === undefined) return;
  row.setAttribute("data-shortcut-focus", "true");
  if (row.id === "") row.id = `${ROW_ID_PREFIX}${focus.index}`;
  const list = row.closest(LIST_SELECTOR);
  if (list === null) return;
  list.setAttribute("role", "group");
  list.setAttribute("aria-activedescendant", row.id);
}

/**
 * Enter the mode: open the sidebar if it is a rail (and remember that), then put the ring on the row of
 * the current pane, or the first row. A rail has no rows until the sidebar has drawn, so the placing
 * waits for {@link settleSidebarFocus}.
 */
export function enterSidebarFocus(): void {
  if (getSidebarFocus() !== null) return;
  if (!isSidebarOpen()) {
    isOpenedByMode = true;
    setSidebarOpen(true);
  }
  isPlacing = true;
  publishSidebarFocus({ index: 0 });
  settleSidebarFocus();
}

/** Place a waiting ring once the rows are drawn, and keep the paint on the DOM the sidebar has now. */
export function settleSidebarFocus(): void {
  if (getSidebarFocus() === null) return;
  const rows = sidebarRows();
  if (isPlacing && rows.length > 0) {
    isPlacing = false;
    publishSidebarFocus({ index: currentIndex(rows) });
    rows[currentIndex(rows)]?.scrollIntoView?.({ block: "nearest" });
  }
  paintSidebarFocus();
}

/** Move the ring by one row, clamped at both ends, no wrap. Changes no route and no view. */
export function moveSidebarFocus(by: -1 | 1): void {
  const focus = getSidebarFocus();
  const rows = sidebarRows();
  if (focus === null || rows.length === 0) return;
  const next = Math.min(rows.length - 1, Math.max(0, focus.index + by));
  publishSidebarFocus({ index: next });
  paintSidebarFocus();
  rows[next]?.scrollIntoView?.({ block: "nearest" });
}

/** Leave the mode's focus: no ring, and the sidebar closed again when the mode opened it. Safe to repeat. */
export function leaveSidebarFocus(): void {
  isPlacing = false;
  publishSidebarFocus(null);
  clearPaint();
  if (!isOpenedByMode) return;
  isOpenedByMode = false;
  setSidebarOpen(false);
}

/** Activate the focused row as a click on it would, then leave. */
export function openSidebarFocus(): void {
  const focus = getSidebarFocus();
  const row = focus === null ? undefined : sidebarRows()[focus.index];
  row?.click();
  leaveSidebarFocus();
}

/** Test seam: no ring, and no memory of having opened the sidebar. */
export function __resetSidebarFocus(): void {
  isOpenedByMode = false;
  isPlacing = false;
  publishSidebarFocus(null);
}

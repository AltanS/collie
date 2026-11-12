// THE ROW THAT WAS PRESSED IS THE ROW THAT OPENS (hitbox investigation, proposal 1).
//
// A tap is two events: `pointerdown` lands on one row, and the `click` is aimed at whatever stands under
// the finger when it lifts. On the dashboard a poll can add or remove a row above the pressed one in
// between, so the list slides 45px and the click lands on a NEIGHBOUR. Measured with 200 real touches:
// 179 of 200 taps opened another pane when a row arrived, 182 of 200 when one left.
//
// So a row remembers the press when the finger lands (`rememberPress`), and a click that arrives on a
// DIFFERENT row, while that press is still live, opens the pressed one instead (`redirectClick`).
//
// THE RULES.
//   1. Only a pointer click is redirected: `event.detail > 0`. A keyboard or screen-reader click has no
//      press behind it (detail 0) and always opens the row it was made on.
//   2. A press lives from `pointerdown` until `pointercancel` (a scroll starts one, and no click follows),
//      or until `RELEASE_GRACE_MS` after `pointerup`, which is long past the click that follows a lift.
//      A press older than that is never consulted, so a stray click cannot reach back to it.
//      A press whose lift the row never sees ends too, so it cannot wait for a click that is hours away: a
//      mouse dragged off the row (`pointerleave`), a row that unmounts under the finger, a right or middle
//      button (`clearPress`), and, whatever else, `PRESS_MAX_MS` after the finger landed (review 1, finding 5).
//   3. A press that became a HOLD opens no pane, and neither does the click on a neighbour that the
//      shifted list sends the lift to: that click is swallowed (`"swallow"`).
//   4. A press on the row the click lands on is no redirect at all: the ordinary tap runs as it always did.
//   5. The press names a pane, never an element. A row that was removed (a pane that moved from one section
//      to another is a new element) still opens its pane; a pane that is gone is the pane route's own
//      "gone" screen, which is the answer a tap on a vanished pane always had.

/** How long a lifted press stays on offer to the click that follows the lift. */
export const RELEASE_GRACE_MS = 400;

/**
 * The longest a press is remembered, lifted or not. Past a long press (500ms) and any hold a person means; a press
 * that is still "down" after this lost its end (a pointer that left the page, an event that never came).
 */
export const PRESS_MAX_MS = 3000;

interface Press {
  /** The row that was pressed: a symbol per mounted row, so two rows of one pane (a pinned copy) differ. */
  readonly owner: symbol;
  /** What that row's tap does. */
  readonly open: () => void;
  /** The press became a long press: it opens the row's actions, and no click may open a pane. */
  held: boolean;
  /** Set when the finger lifted; the press then ends `RELEASE_GRACE_MS` later. */
  timer: ReturnType<typeof setTimeout> | null;
  /** The ceiling: the press ends `PRESS_MAX_MS` after it began, whatever else happens. */
  age: ReturnType<typeof setTimeout> | null;
}

let current: Press | null = null;

function end(press: Press): void {
  if (press.timer !== null) clearTimeout(press.timer);
  if (press.age !== null) clearTimeout(press.age);
  if (current === press) current = null;
}

/** The finger landed on a row. Replaces any press before it: one finger at a time. */
export function rememberPress(owner: symbol, open: () => void): void {
  if (current !== null) end(current);
  const press: Press = { owner, open, held: false, timer: null, age: null };
  press.age = setTimeout(() => end(press), PRESS_MAX_MS);
  current = press;
}

/** The press on `owner` became a hold. */
export function markPressHeld(owner: symbol): void {
  if (current !== null && current.owner === owner) current.held = true;
}

/** The finger lifted: the press ends once the click that follows the lift has had its time. */
export function releasePress(owner: symbol): void {
  const press = current;
  if (press === null || press.owner !== owner) return;
  if (press.timer !== null) clearTimeout(press.timer);
  press.timer = setTimeout(() => end(press), RELEASE_GRACE_MS);
}

/** The browser took the touch (a scroll, a system gesture): no click follows. */
export function cancelPress(owner: symbol): void {
  if (current !== null && current.owner === owner) end(current);
}

/** A right or middle button went down: whatever press is in memory is not a tap any more. */
export function clearPress(): void {
  if (current !== null) end(current);
}

/** What a click on a row does with the press in memory. */
export type ClickRoute = "own" | "swallow" | (() => void);

/**
 * Where a click on the row `owner` goes. `"own"`: run this row's own tap. `"swallow"`: do nothing. A
 * function: run it instead, it opens the row that was pressed.
 */
export function redirectClick(owner: symbol, pointerClick: boolean): ClickRoute {
  const press = current;
  if (!pointerClick || press === null || press.owner === owner) return "own";
  // The click that ends a press consumes it: a second click is nothing this press made.
  end(press);
  return press.held ? "swallow" : press.open;
}

/** Forget everything. For a test, and for a page that is going away. */
export function resetPressMemory(): void {
  if (current !== null) end(current);
  current = null;
}

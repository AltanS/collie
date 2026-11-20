// THE BELT UNDER A MOUSE WHEEL. The Belt is a sideways scroller with no scrollbar, and a wheel turns
// vertically, so on a desktop nothing moved it. This is the pure half: given where the Belt stands and
// what one wheel event carries, how far to put it, and whether the Belt takes the event at all.
//
// The Belt takes a wheel event only when it really moves: it overflows, the delta runs sideways (a
// trackpad's sideways swipe, Shift plus the wheel) or is a plain vertical turn, which maps to sideways,
// and there is room left in that direction. At an end, on a Belt that fits, and on a mostly vertical
// trackpad swipe, it takes nothing, so the event goes on to the page or the strip as it always did.

/** Pixels one wheel "line" is worth, when the device reports lines (Firefox, some mice). */
const LINE_PX = 16;
/** A range under this is a Belt that fits: a scroller at rest reports a fraction over its width. */
const SLACK_PX = 1;

export interface BeltWheelInput {
  readonly scrollLeft: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  /** A right-to-left scroller (the left-hand belt): it rests at 0 and pans into negative `scrollLeft`. */
  readonly rtl: boolean;
  readonly deltaX: number;
  readonly deltaY: number;
  /** `WheelEvent.deltaMode`: 0 pixels, 1 lines, 2 pages. */
  readonly deltaMode: number;
  readonly shiftKey: boolean;
}

export interface BeltWheelDecision {
  /** The Belt takes the event: the caller calls `preventDefault`, so the page and the strip do not move. */
  readonly take: boolean;
  /** Where to put `scrollLeft`. Null when the event is not taken. */
  readonly scrollLeft: number | null;
}

const PASS: BeltWheelDecision = { take: false, scrollLeft: null };

function unitOf(input: BeltWheelInput): number {
  if (input.deltaMode === 1) return LINE_PX;
  if (input.deltaMode === 2) return input.clientWidth;
  return 1;
}

/** The sideways distance in `scrollLeft` terms, or 0 when the event does not mean sideways. */
function sidewaysOf(input: BeltWheelInput): number {
  const unit = unitOf(input);
  const dx = input.deltaX * unit;
  const dy = input.deltaY * unit;
  // A sideways delta is already in `scrollLeft` terms, in both directions of writing.
  if (Math.abs(dx) > Math.abs(dy)) return dx;
  // A vertical turn, plain or with Shift, runs the Belt toward its end: right, and left in a right-to-left one.
  const isVertical = dx === 0 && dy !== 0;
  if (!isVertical) return 0;
  return input.rtl ? -dy : dy;
}

export function decideBeltWheel(input: BeltWheelInput): BeltWheelDecision {
  const range = Math.max(0, input.scrollWidth - input.clientWidth);
  if (range <= SLACK_PX) return PASS;
  const step = sidewaysOf(input);
  if (step === 0) return PASS;
  const low = input.rtl ? -range : 0;
  const high = input.rtl ? 0 : range;
  const next = Math.min(Math.max(input.scrollLeft + step, low), high);
  if (next === input.scrollLeft) return PASS;
  return { take: true, scrollLeft: next };
}

// THE BELT UNDER A MOUSE DRAG. The same scroller, pulled by the pointer: a press that moves past a small
// slop sideways becomes a drag, and `scrollLeft` then follows the pointer one to one from where the press
// began, with no momentum. Only a mouse's primary button starts one; touch and pen keep the browser's own
// scrolling.

/** A press moving less than this (px, sideways) stays an ordinary click. */
export const BELT_DRAG_SLOP_PX = 5;

export interface BeltDragStartInput {
  readonly pointerType: string;
  /** `PointerEvent.button`: 0 is the primary one. */
  readonly button: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
}

/** Whether a press on the scrolling part may become a drag: a mouse's primary button, on a Belt that overflows. */
export function startsBeltDrag(input: BeltDragStartInput): boolean {
  if (input.pointerType !== "mouse" || input.button !== 0) return false;
  return input.scrollWidth - input.clientWidth > SLACK_PX;
}

export interface BeltDragInput {
  /** Where the press began and where the pointer is now, `clientX`. */
  readonly startX: number;
  readonly x: number;
  /** The Belt's `scrollLeft` when the press began. */
  readonly startScrollLeft: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly rtl: boolean;
  /** The drag has already begun: the slop no longer applies. */
  readonly dragging: boolean;
}

export interface BeltDragDecision {
  readonly dragging: boolean;
  /** Where to put `scrollLeft`. Null while the press is still inside the slop. */
  readonly scrollLeft: number | null;
}

/**
 * The drag's state and the Belt's new position for one pointer move. Dragging the pointer left pulls the
 * content left, so `scrollLeft` grows by the distance moved; it is clamped to the Belt's range, which for a
 * right-to-left Belt runs from `-range` to 0.
 */
export function decideBeltDrag(input: BeltDragInput): BeltDragDecision {
  const moved = input.x - input.startX;
  if (!input.dragging && Math.abs(moved) <= BELT_DRAG_SLOP_PX) return { dragging: false, scrollLeft: null };
  const range = Math.max(0, input.scrollWidth - input.clientWidth);
  const low = input.rtl ? -range : 0;
  const high = input.rtl ? 0 : range;
  return { dragging: true, scrollLeft: Math.min(Math.max(input.startScrollLeft - moved, low), high) };
}

// The window a first tap stays armed (#339, M68). A control that must not fire by accident asks for a
// second tap: the first tap only arms, the words change (never the size), and the arm lapses by itself
// after this long. The unread-dialog card (ADR 0053) and the belt's Stop (M68 spec 02) read the one value,
// so the two cannot drift apart.

export const ARM_MS = 4000;

/**
 * The window Enter stays armed while a screen Collie cannot read is open (the M102 review 2, J; review 3): the
 * unread card's Enter cap and the Keys pad's Enter read this one value. Five seconds on that pane and card,
 * whatever the screen's rows do. Longer than {@link ARM_MS}, because the person reads a moving screen between taps.
 */
export const ENTER_ARM_MS = 5000;

/**
 * How long after arming a second tap starts to count (counsel on the Edge 5 candidate). A double tap,
 * or a thumb that lands twice, comes inside this window; a tap there is ignored, neither a Stop nor a
 * disarm. The belt's Stop reads it, and so does Enter on the unread card and on the Keys pad (`useArm`).
 */
export const ARM_DWELL_MS = 400;

/**
 * How long a finger rests on the belt's Stop before the turn is stopped (2026-11-16). The two-tap arm
 * read as a dead button ("Stop?" did not say "tap me again"), so a touch or a mouse now HOLDS: the
 * button fills over this long and stops at the end of the fill. Lifting earlier stops nothing.
 */
export const STOP_HOLD_MS = 2000;

/** How long the Stop says "Hold" after a tap that was lifted too early. */
export const STOP_HINT_MS = 2500;

/**
 * How long a finger rests on the yes to a trick's code before the yes goes out (ADR 0156, the operator's
 * decision of 2026-11-17): switching on a proposed trick and taking a new version. The hold is the guard;
 * reading the code is offered, not required. One value for every card that asks it
 * (components/hold-to-approve.tsx).
 */
export const APPROVE_HOLD_MS = 1500;

/** How long a cancelled hold's fill takes to run back to empty. */
export const HOLD_BACK_MS = 200;

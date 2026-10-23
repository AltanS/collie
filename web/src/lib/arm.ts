// The window a first tap stays armed (#339, M68). A control that must not fire by accident asks for a
// second tap: the first tap only arms, the words change (never the size), and the arm lapses by itself
// after this long. The unread-dialog card (ADR 0053) and the belt's Stop (M68 spec 02) read the one value,
// so the two cannot drift apart.

export const ARM_MS = 4000;

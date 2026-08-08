// Pi 0.82.1 collapses large input into lowercase markers. They are visible terminal state but not
// user-authored text, so the draft preview must never offer to copy one into the phone composer.

const PI_PASTE = /^\[paste #\d+ (?:\+\d+ lines|\d+ chars)\]$/;

export function isPiPastePlaceholder(draft: string): boolean {
  return PI_PASTE.test(draft.trim());
}

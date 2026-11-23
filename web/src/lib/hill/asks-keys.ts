// THE KEYS OF THE ASK SCREEN (Asks build 2, 2026-11-23), as one pure rule: what a key press means on the ask screen and
// on the context page. ← → j k move between asks, 1 to 9 pick an answer, Escape goes up one level. Enter confirms inside
// the confirm sheet, which owns that key itself. A key never acts while a text field has the focus, with a modifier held,
// or while a sheet is up. No key is the only way to anything: every action has a button.

/** What the ask screen does with a key. */
export type AskKeyAction = { kind: "previous" } | { kind: "next" } | { kind: "pick"; number: number } | { kind: "up" } | null;

/** The facts of one key press the rule reads. */
export interface AskKeyPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  /** A text field, a select or an editable region has the focus. */
  typing: boolean;
  /** A sheet is up: it owns the keys, Escape included. */
  sheet: boolean;
}

/** Whether this element takes typed text: such an element keeps every key. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

/** The action of a key press on the ask screen, or null when it is none. */
export function askKeyAction(press: AskKeyPress): AskKeyAction {
  if (press.ctrlKey || press.metaKey || press.altKey || press.isComposing || press.typing || press.sheet) return null;
  switch (press.key) {
    case "ArrowLeft":
    case "k":
      return { kind: "previous" };
    case "ArrowRight":
    case "j":
      return { kind: "next" };
    case "Escape":
      return { kind: "up" };
    default:
      break;
  }
  if (/^[1-9]$/u.test(press.key) && !press.shiftKey) return { kind: "pick", number: Number(press.key) };
  return null;
}

/** Whether a key press in the confirm sheet confirms: Enter alone, never Shift+Enter (a new line), never on a button (it taps itself). */
export function confirmsOnKey(press: Pick<AskKeyPress, "key" | "shiftKey" | "isComposing" | "ctrlKey" | "metaKey" | "altKey"> & { onButton: boolean }): boolean {
  return press.key === "Enter" && !press.shiftKey && !press.isComposing && !press.ctrlKey && !press.metaKey && !press.altKey && !press.onButton;
}

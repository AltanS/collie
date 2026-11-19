// What a press of Enter does in the reply box (ADR 0157, which changes one sentence of ADR 0057).
//
// The question is asked per KEY PRESS, never per device: no web API says "a physical keyboard is
// attached", so each press has to show where it came from. The rule only ever errs one way. When any
// sign is missing or odd, Enter stays what the browser makes it, a new line, and a message is never
// sent by a key that might have come from a phone's on-screen keyboard.
//
// A GUESS NEVER CHANGES WHAT ENTER DOES; ONLY THE PERSON'S TAP DOES. Nothing stored means Enter is a
// new line on every device, a computer with a mouse included. The first press that looks like a real
// keyboard's earns the person one offer of the switch (`hint`); the switch is the choice.
//
// Pure on purpose: no React and no DOM types, so the table test can read every row.

/** The facts of one keydown the rule reads. A DOM `KeyboardEvent` has all of them. */
export interface EnterKeyFacts {
  readonly key: string;
  /** The physical key. An on-screen keyboard usually leaves it empty; a hardware one says "Enter" or "NumpadEnter". */
  readonly code: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  /** True while an input method (IME) composition is open. Its confirming Enter must never send. */
  readonly isComposing: boolean;
  /** 229 means "an input method handled this key". Some browsers report it without `isComposing`. */
  readonly keyCode: number;
  readonly repeat: boolean;
}

/**
 * - `send`: send the message (the caller stops the key and sends).
 * - `swallow`: do nothing and add no new line. A held Enter repeats; the first press sent, and the
 *   repeats must not type new lines into the box that the send just emptied.
 * - `hint`: the person has not chosen and this press looks like a real keyboard's. The key still adds
 *   its new line (the caller leaves it to the browser) and the caller offers the switch once.
 * - `default`: leave the key to the browser (a new line).
 */
export type EnterAnswer = "send" | "swallow" | "hint" | "default";

/** The person's stored choice: `on`, `off`, or `null` when they never chose. */
export type EnterChoice = "on" | "off" | null;

/** The key codes a hardware Enter reports. */
const HARDWARE_ENTER_CODES: ReadonlySet<string> = new Set(["Enter", "NumpadEnter"]);

/** The key code an input method uses for a key it handled (`VK_PROCESSKEY`). */
const IME_KEY_CODE = 229;

/**
 * What a keydown does. `softKeyboardUp` is the app's own height test (hooks/use-keyboard.ts) and
 * `choice` is the per-device setting (lib/enter-sends-store.ts).
 */
export function enterKeyAnswer(facts: EnterKeyFacts, softKeyboardUp: boolean, choice: EnterChoice): EnterAnswer {
  if (facts.key !== "Enter") return "default";
  // Ctrl+Enter and Cmd+Enter always send, with the setting on, off or never chosen. They are older than it.
  if (facts.ctrlKey || facts.metaKey) return "send";
  // Shift+Enter and Alt+Enter are the person asking for a new line.
  if (facts.shiftKey || facts.altKey) return "default";
  if (choice === "off") return "default";
  if (!fromRealKeyboard(facts, softKeyboardUp)) return "default";
  if (choice === "on") return facts.repeat ? "swallow" : "send";
  // Never chosen: the first press of a real keyboard earns the offer. A repeat is a held key, not a new press.
  return facts.repeat ? "default" : "hint";
}

/**
 * Whether a bare Enter looks like a physical keyboard's. Every sign must hold, and any doubt says no.
 * Composition is checked twice: Safari can report the confirming Enter after the composition has ended,
 * with keyCode 229 only. A key that names no hardware Enter code, or any press while the on-screen
 * keyboard is up (iOS may fill `code` in), is not trusted.
 */
function fromRealKeyboard(facts: EnterKeyFacts, softKeyboardUp: boolean): boolean {
  if (facts.isComposing || facts.keyCode === IME_KEY_CODE) return false;
  return HARDWARE_ENTER_CODES.has(facts.code) && !softKeyboardUp;
}

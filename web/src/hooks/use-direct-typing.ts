import { useEffect, useRef, useState } from "react";
import type {
  ChangeEvent,
  CompositionEvent as ReactCompositionEvent,
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
} from "react";

import { useOrderedKeySender } from "@/hooks/use-ordered-key-sender";
import { textToKeySequence } from "@/lib/key-queue";
import { setStatus } from "@/lib/status";

// Physical-keyboard events that do not change a textarea value still need wire names. Printable
// text, spaces and line breaks normally arrive through the input/change path instead.
const SPECIAL_KEYS: Readonly<Record<string, string>> = {
  Escape: "Escape",
  Tab: "Tab",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

function keyForInputType(inputType: string): string | null {
  if (inputType === "deleteContentBackward") return "Backspace";
  if (inputType === "insertLineBreak" || inputType === "insertParagraph") return "Enter";
  return null;
}

function keyForKeyDown(key: string): string | undefined {
  if (key === "Backspace") return "Backspace";
  if (key === "Enter") return "Enter";
  return SPECIAL_KEYS[key];
}

interface DirectTypingOptions {
  paneKey: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  replyDraft: string;
  canActivate: () => boolean;
  /** True while the view the mode belongs to has stopped being live: a gone pane, a read-only
   *  device, or the idle pause. Arming survives none of them — see the disarm effect below. */
  suspended: boolean;
  sendKeys: (keys: string[]) => Promise<boolean>;
  onActivate: () => void;
  focusInput: () => void;
}

// The composer textarea's direct-terminal mode: what you type goes to the pane as keystrokes,
// with no trailing Enter. This hook owns the armed state, the transient Android IME composition
// value, the pane-boundary reset, special-key capture, and the lifecycle rules that disarm it.
// Transport ordering stays in useOrderedKeySender so this hook never permits concurrent one-shot
// Herdr writes.
//
// It does NOT own the entry point. Arming is an explicit NAMED choice — the "Type" toggle in the
// composer's Controls row, beside Keys.
//
// WHY A NAMED CHOICE AND NOT A GESTURE. The submitted version of this feature armed the mode on a
// bare long press of the Send button. That reads as a saving of one tap, but the tap is priced per
// SESSION, not per keystroke: you arm once and then type many keys. What it actually buys is an
// accidental hold — a pocket, a fumbled scroll, a hesitation over Send with a destructive command in
// the box — silently pointing the phone keyboard at a live terminal with nothing on screen having
// asked. This surface's safety story is "you see what is about to go on the wire" (ADR 0005), and a
// mode you can enter without reading anything sits outside it. A labelled toggle you press on purpose
// is the cheapest thing that stays inside it. Don't reintroduce a hold as a shortcut.
//
// WHY THE MODE DIES WITH THE VIEW. What stands in for a review step here is that you are LOOKING at
// the pane while you type into it — this is the one write path with no reviewable payload, by design
// (reviewing each keystroke would defeat it). That condition can quietly stop being true: the mirror
// is polled, and the poll stops on an idle pause (ADR 0007), on a backgrounded tab, on a pane going
// away. Hence the disarms below. Never persisted, never restored: there is no path by which this is
// already armed when you arrive at a screen.
//
// Two apparent omissions that are deliberate. A lost connection is NOT a separate trigger — it
// surfaces as a failed batch, which already disarms, observed directly rather than inferred from a
// timer. And the reply guard's `composerReady` pre-flight is NOT run on these keystrokes: it refuses
// to type into an unrecognised screen, and typing into an unrecognised screen is the whole point.
// Don't "harden" this path by adding it.
export function useDirectTyping({
  paneKey,
  inputRef,
  replyDraft,
  canActivate,
  suspended,
  sendKeys,
  onActivate,
  focusInput,
}: DirectTypingOptions) {
  const [active, setActive] = useState(false);
  const [value, setValue] = useState("");
  const composing = useRef(false);
  const committedComposition = useRef<string | null>(null);
  const sender = useOrderedKeySender(sendKeys, () => {
    setActive(false);
    setValue("");
    composing.current = false;
    committedComposition.current = null;
    // Stop the phone keyboard too: otherwise continued typing after a transport failure silently
    // becomes a buffered Reply, which is a different action with an eventual Enter attached. Defer
    // past the activation focus timer so even an immediate failure cannot be re-focused behind us.
    setTimeout(() => inputRef.current?.blur(), 0);
  });

  function activate() {
    if (!canActivate()) return;
    // A buffered reply and live keystrokes cannot safely share one field. Keep the durable draft
    // exactly where it is and make the user send or clear it before arming direct terminal input.
    if (replyDraft.length > 0) {
      setStatus("Send or clear the draft before typing into the terminal.", "info");
      return;
    }
    onActivate();
    setValue("");
    composing.current = false;
    committedComposition.current = null;
    setActive(true);
    setStatus("Typing into the terminal — keys send as you type.", "success");
    // Focus synchronously while the long-press/contextmenu gesture still carries browser user
    // activation; a deferred focus selects the field but mobile browsers may refuse to open their
    // software keyboard once that activation has expired. The existing callback still runs after
    // React swaps the controlled value so selection lands at the end.
    inputRef.current?.focus();
    focusInput();
  }

  function clearMode() {
    setActive(false);
    setValue("");
    composing.current = false;
    committedComposition.current = null;
    focusInput();
  }

  function deactivate() {
    clearMode();
    setStatus("Back to sending replies", "info");
  }

  function deactivateSilently() {
    clearMode();
  }

  // Arming dies with the view it belongs to. A backgrounded tab, an idle pause and a lost bridge
  // all mean the same thing: the mirror on screen has stopped tracking the pane, and the next
  // keystroke would go into a terminal the user is no longer actually looking at. Disarm rather
  // than hold the mode open across the gap — the cost is one re-arm, the alternative is typing
  // blind. Never persisted, never restored — see the lifecycle note in send-mode-menu.tsx.
  useEffect(() => {
    if (!active || !suspended) return;
    clearMode();
    setStatus("Stopped typing into the terminal — the pane view was interrupted.", "info");
  }, [active, suspended]);

  useEffect(() => {
    if (!active) return;
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      clearMode();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [active]);

  // Direct input never crosses a pane boundary. Reset also invalidates keys accumulated behind an
  // in-flight call; the call already on the wire captured the old pane and cannot be recalled.
  useEffect(() => {
    setActive(false);
    setValue("");
    composing.current = false;
    committedComposition.current = null;
    sender.reset();
  }, [paneKey, sender.reset]);

  // Android virtual Backspace/Enter can arrive as beforeinput without a useful keydown. A native
  // listener is intentional: React's synthetic beforeinput omits these events on some engines.
  useEffect(() => {
    const inputEl = inputRef.current;
    if (!active || inputEl === null) return;
    const onBeforeInput = (event: InputEvent) => {
      const key = keyForInputType(event.inputType);
      if (key === null) return;
      // Backspace inside an active IME edits the candidate; Enter commits/submits and must still reach
      // the terminal. Gboard commonly marks that insertParagraph event as composing.
      if (event.isComposing && key === "Backspace") return;
      event.preventDefault();
      sender.enqueue([key]);
    };
    inputEl.addEventListener("beforeinput", onBeforeInput);
    return () => inputEl.removeEventListener("beforeinput", onBeforeInput);
  }, [active, inputRef, sender.enqueue]);

  function onChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const next = event.target.value;
    setValue(next);
    const inputEvent = event.nativeEvent as InputEvent;
    if (inputEvent.isComposing || composing.current) return;

    // Gboard can follow compositionend with one ordinary input carrying the same committed word.
    // Drop that prefix rather than sending a swipe twice, while preserving any suffix typed in the
    // same event (commonly the auto-inserted space before the next swiped word).
    const committed = committedComposition.current;
    if (committed !== null) {
      committedComposition.current = null;
      const remainder = next.startsWith(committed) ? next.slice(committed.length) : next;
      if (remainder.length > 0) sender.enqueue(textToKeySequence(remainder));
      setValue("");
      return;
    }

    if (next.length === 0) return;
    sender.enqueue(textToKeySequence(next));
    setValue("");
  }

  function onCompositionStart() {
    composing.current = true;
    committedComposition.current = null;
  }

  function onCompositionEnd(event: ReactCompositionEvent<HTMLTextAreaElement>) {
    composing.current = false;
    const committed = event.currentTarget.value || event.data;
    if (committed.length === 0) return;
    committedComposition.current = committed;
    sender.enqueue(textToKeySequence(committed));
    setValue("");
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    const key = keyForKeyDown(event.key);
    if (key === undefined) return;
    event.preventDefault();
    sender.enqueue([key]);
  }

  return {
    active,
    value,
    busy: sender.busy,
    activate,
    deactivate,
    deactivateSilently,
    onChange,
    onCompositionStart,
    onCompositionEnd,
    onKeyDown,
  };
}

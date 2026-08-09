import { useCallback, useEffect, useState } from "react";
import type {
  ChangeEvent,
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
} from "react";

import { useLongPress } from "@/hooks/use-long-press";
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

interface ImmediateInputOptions {
  paneKey: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  replyDraft: string;
  canActivate: () => boolean;
  sendKeys: (keys: string[]) => Promise<boolean>;
  onActivate: () => void;
  focusInput: () => void;
}

// The normal composer textarea's direct-terminal mode. It owns the activation gesture, transient
// Android IME composition value, pane-boundary reset and special-key capture; transport ordering
// stays in useOrderedKeySender so this hook never permits concurrent one-shot Herdr writes.
export function useImmediateInput({
  paneKey,
  inputRef,
  replyDraft,
  canActivate,
  sendKeys,
  onActivate,
  focusInput,
}: ImmediateInputOptions) {
  const [active, setActive] = useState(false);
  const [value, setValue] = useState("");
  const sender = useOrderedKeySender(sendKeys, () => {
    setActive(false);
    setValue("");
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
      setStatus("Send or clear the draft before starting Immediate mode.", "info");
      return;
    }
    onActivate();
    setValue("");
    setActive(true);
    setStatus("Immediate mode on — keys send as you type.", "success");
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
    focusInput();
  }

  function deactivate() {
    clearMode();
    setStatus("Immediate mode off", "info");
  }

  function deactivateSilently() {
    clearMode();
  }

  // A normal tap keeps the Send button's existing meaning. Holding toggles Immediate mode;
  // useLongPress suppresses the synthesized click after the hold, including Android's contextmenu.
  const longPressAction = active ? deactivate : activate;
  const focusAfterLongPress = useCallback(() => {
    inputRef.current?.focus();
  }, [inputRef]);
  const longPress = useLongPress(canActivate() ? longPressAction : undefined, {
    onReleaseAfterLongPress: focusAfterLongPress,
  });

  // Direct input never crosses a pane boundary. Reset also invalidates keys accumulated behind an
  // in-flight call; the call already on the wire captured the old pane and cannot be recalled.
  useEffect(() => {
    setActive(false);
    setValue("");
    sender.reset();
  }, [paneKey, sender.reset]);

  // Android virtual Backspace/Enter can arrive as beforeinput without a useful keydown. A native
  // listener is intentional: React's synthetic beforeinput omits these events on some engines.
  useEffect(() => {
    const inputEl = inputRef.current;
    if (!active || inputEl === null) return;
    const onBeforeInput = (event: InputEvent) => {
      if (event.isComposing) return;
      const key = keyForInputType(event.inputType);
      if (key === null) return;
      event.preventDefault();
      sender.enqueue([key]);
    };
    inputEl.addEventListener("beforeinput", onBeforeInput);
    return () => inputEl.removeEventListener("beforeinput", onBeforeInput);
  }, [active, inputRef, sender.enqueue]);

  function onChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const next = event.target.value;
    setValue(next);
    // Keep an Android IME's in-progress composition local. Its final change event arrives with
    // isComposing=false and sends the committed string in one ordered batch.
    const inputEvent = event.nativeEvent as InputEvent;
    if (inputEvent.isComposing || next.length === 0) return;
    sender.enqueue(textToKeySequence(next));
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
    longPress,
    deactivate,
    deactivateSilently,
    onChange,
    onKeyDown,
  };
}

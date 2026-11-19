import { describe, expect, it } from "vitest";

import { enterKeyAnswer, type EnterAnswer, type EnterChoice, type EnterKeyFacts } from "./enter-key";

const HARDWARE: EnterKeyFacts = {
  key: "Enter",
  code: "Enter",
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  isComposing: false,
  keyCode: 13,
  repeat: false,
};

interface Row {
  readonly name: string;
  readonly facts: Partial<EnterKeyFacts>;
  readonly softKeyboardUp: boolean;
  readonly choice: EnterChoice;
  readonly answer: EnterAnswer;
}

const row = (
  name: string,
  facts: Partial<EnterKeyFacts>,
  choice: EnterChoice,
  answer: EnterAnswer,
  softKeyboardUp = false,
): Row => ({ name, facts, softKeyboardUp, choice, answer });

const ROWS: readonly Row[] = [
  // Not Enter.
  row("a letter, on", { key: "a", code: "KeyA" }, "on", "default"),
  row("Tab, never chosen", { key: "Tab", code: "Tab" }, null, "default"),
  // Ctrl and Cmd send with the setting on, off or never chosen, and whatever the keyboard.
  row("Ctrl+Enter, off", { ctrlKey: true }, "off", "send"),
  row("Cmd+Enter, off", { metaKey: true }, "off", "send"),
  row("Ctrl+Enter, never chosen", { ctrlKey: true }, null, "send"),
  row("Cmd+Enter, never chosen", { metaKey: true }, null, "send"),
  row("Ctrl+Enter, on", { ctrlKey: true }, "on", "send"),
  row("Cmd+Enter, on", { metaKey: true }, "on", "send"),
  row("Ctrl+Enter, empty code, soft keyboard up, off", { ctrlKey: true, code: "" }, "off", "send", true),
  // On: the hardware Enter sends.
  row("hardware Enter, on", {}, "on", "send"),
  row("numpad Enter, on", { code: "NumpadEnter" }, "on", "send"),
  // Off: a bare Enter is a new line and nothing is offered.
  row("hardware Enter, off", {}, "off", "default"),
  row("numpad Enter, off", { code: "NumpadEnter" }, "off", "default"),
  // Never chosen: a bare Enter is a new line, and the first real-looking press earns the offer. It never sends.
  row("hardware Enter, never chosen", {}, null, "hint"),
  row("numpad Enter, never chosen", { code: "NumpadEnter" }, null, "hint"),
  // Shift and Alt ask for a new line, with no offer.
  row("Shift+Enter, on", { shiftKey: true }, "on", "default"),
  row("Alt+Enter, on", { altKey: true }, "on", "default"),
  row("Shift+Alt+Enter, on", { shiftKey: true, altKey: true }, "on", "default"),
  row("Shift+Enter, never chosen", { shiftKey: true }, null, "default"),
  row("Alt+Enter, never chosen", { altKey: true }, null, "default"),
  // An input method's confirming Enter never sends and never offers.
  row("Enter while composing, on", { isComposing: true }, "on", "default"),
  row("Enter with keyCode 229 and no composing flag, on", { keyCode: 229 }, "on", "default"),
  row("Enter composing and keyCode 229, on", { isComposing: true, keyCode: 229 }, "on", "default"),
  row("Enter while composing, never chosen", { isComposing: true }, null, "default"),
  row("Enter with keyCode 229, never chosen", { keyCode: 229 }, null, "default"),
  // A press that does not name itself a hardware Enter.
  row("empty code (an on-screen keyboard), on", { code: "" }, "on", "default"),
  row("Unidentified code, on", { code: "Unidentified" }, "on", "default"),
  row("another key's code, on", { code: "KeyJ" }, "on", "default"),
  row("empty code, never chosen", { code: "" }, null, "default"),
  row("Unidentified code, never chosen", { code: "Unidentified" }, null, "default"),
  // The on-screen keyboard is up, even when the press claims a hardware code (iOS may fill it in).
  row("hardware code with the soft keyboard up, on", {}, "on", "default", true),
  row("empty code with the soft keyboard up, on", { code: "" }, "on", "default", true),
  row("hardware code with the soft keyboard up, never chosen", {}, null, "default", true),
  // A held key: the first press sent, the repeats do nothing and add no lines.
  row("a repeat of a hardware Enter, on", { repeat: true }, "on", "swallow"),
  row("a repeat with an empty code is the browser's, on", { repeat: true, code: "" }, "on", "default"),
  row("a repeat with the soft keyboard up is the browser's, on", { repeat: true }, "on", "default", true),
  row("a repeat while composing is the browser's, on", { repeat: true, isComposing: true }, "on", "default"),
  row("a repeat with the choice off is the browser's", { repeat: true }, "off", "default"),
  row("a repeat of Shift+Enter is the browser's, on", { repeat: true, shiftKey: true }, "on", "default"),
  // A repeat is not a new press, so it never offers.
  row("a repeat, never chosen", { repeat: true }, null, "default"),
];

describe("enterKeyAnswer", () => {
  it.each(ROWS)("$name", ({ facts, softKeyboardUp, choice, answer }) => {
    expect(enterKeyAnswer({ ...HARDWARE, ...facts }, softKeyboardUp, choice)).toBe(answer);
  });

  // The operator's rule (2026-11-19): a guess never changes what Enter does. With nothing stored, no
  // combination of facts may answer "send" for a bare Enter, whatever the device looks like.
  it("never sends a bare Enter while nothing is stored", () => {
    const flags = [false, true];
    for (const code of ["Enter", "NumpadEnter", "", "Unidentified"])
      for (const keyCode of [13, 229, 0])
        for (const isComposing of flags)
          for (const repeat of flags)
            for (const soft of flags)
              expect(enterKeyAnswer({ ...HARDWARE, code, keyCode, isComposing, repeat }, soft, null)).not.toBe("send");
  });
});

# 0157: Enter sends when the person turns it on and the key came from a keyboard

- **Status:** Accepted (2026-11-19)
- **Date:** 2026-11-19
- **Amends in scope:** [ADR 0057](./0057-the-composer-is-one-box.md), the sentence that says Enter is the one key Collie
  cannot spend.
- **Trail:** Issue 812 (`@mfrep`): on a physical keyboard Enter should send from the reply box, and today it
  adds a line. Roads turned down by the operator on 2026-11-19: Enter sends for every device, a default
  chosen by device (a mouse, a screen size), and a switch that decides from a guess. "A guess must never
  change what Enter does. Only the person's tap does."
  Files: `web/src/lib/enter-key.ts`, `web/src/lib/enter-sends-store.ts`, `web/src/components/composer.tsx`
  (the key handler, the offer above the box),
  `web/src/components/durable-composer.tsx`, `web/src/components/enter-sends-control.tsx`,
  `docs/configure.md`

## Context

[ADR 0057](./0057-the-composer-is-one-box.md) declined the prompt kits' keymap with one sentence: Enter
sends there, and it is "the one key Collie cannot spend", because the draft goes to a terminal and Enter
is a shell character. That held while every Enter in the box could come from a phone's on-screen keyboard,
where the return key is the only way to a new line and a send by mistake is not undone.

A person at a desk with a keyboard has Shift+Enter for the new line, and wants Enter to send. The only
question is how to give them that without ever sending from a phone's return key.

No web API says a physical keyboard is attached. `navigator.virtualKeyboard` reports the on-screen
keyboard's geometry only, `navigator.keyboard` reports layouts and locks keys, and the proposal of a
`keyboard.type` property and a media query never shipped. So the answer cannot come from the device.
It comes from each key press.

## Decision

1. **Enter is a new line until the person turns "Enter sends" on.** The choice is `on`, `off`, or nothing,
   kept per device in `collie:enter-sends:v1` and never written to a bridge. Nothing stored means a new
   line on every device, a computer with a mouse included. No guess sets the choice. Only a tap does.
2. **With the choice `on`, a bare Enter sends only when all four checks hold.** (a) No composition is open:
   `isComposing` is false and `keyCode` is not 229. (b) It is not a repeat. (c) `code` is `Enter` or
   `NumpadEnter`. (d) The on-screen keyboard is not up (`useKeyboardOpen`). Any other press is left to the
   browser, a new line. Shift+Enter and Alt+Enter are a new line. The repeats of a held Enter that passed the
   other checks are stopped, so the first press sends and the emptied box gets no new lines.
3. **The first press that passes the same checks, with nothing stored, offers the switch once.** That Enter
   still adds its new line. One line above the box says "Using a keyboard? Enter can send." with Turn on and
   a dismiss control. Turn on stores `on`, dismiss stores `off`, and neither shows the line again on this
   device. A pane change or a reload hides it without storing anything.
4. **Unsure means a new line, never a send.** A wrong guess can cost one new line or one offer, never a
   message the person did not send.
5. **What stays:** Ctrl/Cmd+Enter sends, with the choice on, off or nothing. Type mode has its own handler.
   The Send button is the way on a phone. The sign-in code field, the menus and suggestion lists above the
   box take no Enter. The durable agent's reply box follows the same rule with the same switch, and offers
   no switch of its own, since the offer stays in the main reply box. The expanded full-screen editor keeps
   Ctrl/Cmd+Enter only, on purpose: it is the place for long text with many lines.

## Consequences

- **The facts behind check (c) and (d), with their sources.** Gboard on Android Chrome reports `keyCode` 229
  and `key` "Unidentified" for typed keys, and an empty `code` for its keys, the return key included
  (a developer's test on Android 11: empty `code`, `key` "Enter", `keyCode` 13 for Done; one write-up, not
  a spec). The W3C UI Events spec lets a virtual keyboard leave `code` empty. A hardware keyboard reports
  `code` `Enter` or `NumpadEnter`. One write-up of iOS 17 Safari shows `code` filled in for its on-screen
  keys, which is why check (d) is a second, independent sign and why `code` alone is never trusted.
  Safari can fire the confirming Enter of an input method after the composition ended, which is why
  `keyCode` 229 is checked beside `isComposing` (Chrome's guide on IME-safe Enter, WebKit bug 165004).
  Sources: MDN (`VirtualKeyboard API`, `Keyboard API`, `KeyboardEvent.code`), W3C UI Events, the WICG thread on
  keyboard type detection.
- **Unproven:** there is no iOS device here, and no real Gboard run. A floating or split on-screen keyboard
  can fail the height test of (d); then only an empty `code` stands between a return key and a send.
  Revisit with a real device run, or if a `code`-filling on-screen keyboard is reported.
- Check (d) uses the same height test as the rest of the composer (`hooks/use-keyboard.ts`).

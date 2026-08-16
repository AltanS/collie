# 0017 — Recognising a password prompt changes what Collie says, never what it sends

Status: **Accepted** (2026-08-16)

## Context

The free-text reply path is guarded. It types the text **unsubmitted**, polls fresh pane reads until
the harness adapter can see that text on the input line, and only then sends the submit key. That
ordering is the fix for [#34](https://github.com/AltanS/collie/issues/34), where a blind Enter
answered a focused permission dialog and approved the highlighted "Yes" while the bridge cheerfully
reported `{ok: true}` — both Herdr RPCs really had succeeded.

A password prompt breaks that guard in a way nothing else does. `sudo`, an SSH key passphrase and
`gpg` all turn echo **off**: the characters reach the pane and the terminal deliberately renders
nothing. The evidence the guard waits for is not slow, not flaky, and not missing by accident — it is
being withheld on purpose, forever. So the submit key is never sent, and no retry, no longer poll
window and no better adapter will change that.

[#103](https://github.com/AltanS/collie/issues/103) is what that cost in practice. The reporter hit a
`sudo` prompt from the phone, got "The agent's input box isn't on screen — a menu or dialog is
probably up", went looking for a dialog that did not exist, and walked to a laptop. For three days.
The remedy was one control away the whole time — **Type**, which sends keystrokes straight to the
pane with no verification at all, Enter included, because typing into an unrecognised screen is its
entire purpose — and nothing on screen connected the two.

Once Collie can *recognise* the screen (a conservative, anchored match on the live tail:
`[sudo] password for …:`, `user@host's password:`, `Enter passphrase …:`), three roads open, and two
of them are the obvious ones:

1. **Send it.** We know it's a password prompt, we know the guard's evidence can't arrive, so skip the
   verification for this one case and press Enter after typing. One tap, no mode switch, no
   explanation needed.
2. **Build a secret channel.** A first-class "send a password" field that types and submits through a
   dedicated path, bypassing the guard by design rather than by exception. Issue #103 sketches this
   as its third suggestion.
3. **Say what it is and point at the control that already works.**

Road 1 is the dangerous one precisely because it looks safest. The premise "we know it's a password
prompt" is a *heuristic over the mirror*, and the mirror is a rendered grid Collie does not emulate
([ADR 0008](./0008-collie-does-not-run-a-terminal-emulator.md)). An agent that prints
`Enter passphrase:` as the last line of its own output — narrating, quoting a runbook, echoing a log
— produces a screen indistinguishable from the real thing at the tail. Send Enter there and the
keystroke lands in whatever actually owns the keyboard, which on a stalled send is most likely the
dialog #34 is about. The guard would then be defeated by the one input Collie chose to trust without
evidence, and the failure would be silent: an approved permission dialog looks like a successful
send.

Road 2 inherits all of that and adds a surface to maintain. It also solves nothing Type does not
already solve — Type has no verification to bypass, dies with the view it belongs to, and is armed by
a named choice the operator reads before arming.

There is a second, quieter problem that recognition *does* legitimately fix. The composer's
write-through persists every keystroke to `localStorage` for 48 hours, so by the time any refusal is
rendered the password is already stored — and it is stored on the path where the operator gives up
and walks away, which is exactly what #103 describes doing.

## Decision

**Recognising a no-echo prompt changes what Collie says and what it stores. It never changes what it
sends.**

Concretely:

- The refusal is unchanged in kind and in consequence — nothing is typed, no key is sent. Only the
  wording changes: it names the mechanism ("it shows nothing as you type, so Send can never confirm
  the text arrived") instead of guessing at a dialog.
- **No automatic Enter, ever**, and no relaxation of the type-then-verify guard for a recognised
  screen. Detection is not evidence; it is a guess about a grid.
- The remedy offered is the existing **Type** mode, entered by the operator's own tap. Nothing new
  types on their behalf.
- The pre-existing "Type anyway?" override stays exactly where it was. A false positive must cost a
  dismissable notice, never an action taken or an action withdrawn.
- On the stall path, a screen the adapter still recognises as its own composer is **never** called a
  password prompt — otherwise "press Enter" becomes advice for the #34 keystroke.
- Recognition **drops the stored draft and stops persisting keystrokes** while it holds. This is the
  one thing recognition is allowed to do on its own, because its worst case is a draft that fails to
  survive the OS killing the PWA.

## Consequences

- A password prompt costs one extra deliberate tap (Use Type) rather than zero. That is the price of
  never firing an unverified Enter, and it is the same price every other write path in Collie pays.
- Recognition is conservative and English-only, so unrecognised prompts get the older, vaguer
  refusal. That is a *fallback*, not a failure: a false negative lands the operator exactly where
  0.29.0 left them, which is why the patterns are allowed to stay literal instead of clever.
- Collie has no "send a secret" feature, and requests for one should be answered with Type unless
  something changes below.
- A password still ends up typed into a real terminal, and Collie still mirrors, polls and stores
  history for that pane. Nothing here changes that; what it establishes is that Collie's own copy of
  the secret ends at the keystroke — direct-typing state is component-local and cleared per batch, and
  the draft store is closed for the duration.
- **What would justify revisiting.** Not a nicer heuristic — a *source of truth*. If Herdr ever
  reports the pane's echo state (a `termios ECHO` bit, or a prompt kind on the pane record), then
  "this is a no-echo prompt" stops being a guess about rendered text and road 1 becomes a different
  proposition, worth re-arguing on that evidence. Until then, the guard's contract holds: a key that
  cannot be verified is not sent.

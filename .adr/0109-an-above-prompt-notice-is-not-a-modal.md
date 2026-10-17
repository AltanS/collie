# 0109: an above-prompt notice is not a modal

- **Status:** Proposed
- **Date:** 2026-10-17
- **Trail:** `web/src/lib/surface/notice.ts` (the one reader) · `idle.notices` in `web/src/lib/surface/profiles/claude.json` · `web/src/lib/surface/cues.ts` · `bridge/surface/protocol.ts` (`gateSend`) · `web/src/lib/harness/claude/above-prompt-notice.ts` · `web/src/lib/harness/conformance.ts` · fixture `claude--v2302-heads-up-above-box--w142.txt` · [ADR 0009](./0009-a-generic-menu-is-driven-by-the-keys-it-names.md)

## Context

Claude Code 2.1.302's built-in `you-should-know` plugin draws a notice above the input box while the box keeps focus: a `✦ Heads up · ` (or `✦ You should know · `) head, its text wrapped onto indented rows, and one row of keys, `1: Learn more   2: Knew this already   0: Dismiss`.

The keys act only when the box's whole value is exactly one valid digit. About 400 ms later the plugin fires and clears the box, with no Enter. Digits are ignored for about 600 ms after the notice appears, and a longer message is left alone.

The single-key cue read the key row as a single-key prompt, so the screen folded `modal: "unreadable"` and every send became the two-tap manual Send. The phone showed no card either, because the row names no `<key> to <verb>` footer.

## Decision

**An above-prompt notice whose keys act only on a one-character box leaves the box free for the Send Protocol.** A profile names the notice by its head row (`idle.notices`). One pure reader, `readAboveNotice`, reads the exact shape: the head, up to three continuation rows indented by two spaces, one key row of `<digit>: <label>` items only, then only blank rows down to the box's top edge.

Anything else returns null, and the modal cues read the rows as before, so a block that is nearly a notice keeps its strong cue. The rating survey over the box (`● How is Claude doing this session?`) is not this shape and stays `unreadable`.

**A one-digit message still goes manual.** When S0 shows a notice and a send's whole text, trimmed, is one of its printed keys, `gateSend` takes the manual Send: the first tap is refused `unconfirmed` with "That digit would answer the notice above the box. Check the pane, then tap Type here.", and the commit goes on the same rows hash.

Typed into that box, the digit answers the notice instead of reaching the agent, so the person must see the screen first. Any other text, `10` included, goes on one tap.

**The card sends only printed keys.** The notice lifts as a `menu` card with one button per printed key, its label and its digit exactly as printed, in printed order. Its model carries `liveBox`: the card owns no keyboard (`blockOwnsKeyboard` is false), so the composer stays free and no ask is lifted. While the box holds a draft the buttons are off, because a digit would join the draft. A tap sends the digit bound to the notice's rows.

**The digits are outside ADR 0009's numbered-row ban.** ADR 0009 forbids a digit inferred from a numbered list row, because in the `/model` picker a digit confirms and persists. These digits are the keys the notice's own row prints as `<digit>: <label>`: no key is synthesised. The conformance suite holds a notice card to that: each key is a digit its key row printed, `composerReady` is true, and a row spliced between the key row and the box lifts no card.

**The tail-anchoring check exempts a notice card.** That check appends ordinary output under a fixture and expects no card. Under a live box, the frame walk reads output rows as status rows, so the notice still lifts there. The exemption is safe for two reasons. The card lifts only with Claude's live input box found under it. And its tap is bound to the notice's rows by the prompt-binding check, so a tap on a notice that has gone is refused rather than typed.

## Consequences

A screen with the notice reads free, and sends that are not one of its digits go on one tap. The notice's own answer is one tap on the card. A head the plugin draws in another word, or a key row with any other item, falls back to the strong cue and the manual Send, which fails closed.

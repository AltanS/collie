# 0109: an above-prompt notice is not a modal

- **Status:** Proposed
- **Date:** 2026-10-17
- **Trail:** `web/src/lib/surface/notice.ts` (the one reader) · `idle.notices` in `web/src/lib/surface/profiles/claude.json` · `web/src/lib/surface/cues.ts` · `bridge/surface/protocol.ts` (`gateSend`) · `web/src/lib/harness/claude/above-prompt-notice.ts` · `web/src/lib/harness/conformance.ts` · fixtures `claude--v2302-heads-up-above-box--w142.txt`, `claude--v2303-titled-edge-survey--w160.txt` and the `claude--v2304-heads-up-*` follow-ups · `web/src/components/menu-block.tsx` (a body notice's mirror) · opposes [ADR 0009](./0009-a-generic-menu-is-driven-by-the-keys-it-names.md)'s no-digits rule, on the owner's ruling that the notice must not block sends and the phone shows it as a card with its buttons

## Context

Claude Code 2.1.302's built-in `you-should-know` plugin draws a notice above the input box while the box keeps focus: a `✦ Heads up · ` (or `✦ You should know · `) head, its text wrapped onto indented rows, and one row of keys, `1: Learn more   2: Knew this already   0: Dismiss`.

The keys act only when the box's whole value is exactly one valid digit. About 400 ms later the plugin fires and clears the box, with no Enter. Digits are ignored for about 600 ms after the notice appears, and a longer message is left alone.

The single-key cue read the key row as a single-key prompt, so the screen folded `modal: "unreadable"` and every send became the two-tap manual Send. The phone showed no card either, because the row names no `<key> to <verb>` footer.

## Decision

**An above-prompt notice whose keys act only on a one-character box leaves the box free for the Send Protocol.** A profile names the notice by its head row (`idle.notices`). One pure reader, `readAboveNotice`, reads the exact shape: the head, up to three continuation rows indented by two spaces, one key row of `<digit>: <label>` items only, then only blank rows down to the box's top edge.

Anything else returns null, and the modal cues read the rows as before, so a block that is nearly a notice keeps its strong cue. The rating survey over the box (`● How is Claude doing this session? (optional)`) is the second shape the profile names, since 2026-10-19 (see the addendum).

**A one-digit message still goes manual.** A digit answers the notice only when the box is otherwise empty, so the rule runs only where a send would go ahead on an empty box. When S0 shows a notice, the box is empty, and a send's whole text, trimmed, is one of the notice's printed keys, `gateSend` takes the manual Send: the first tap is refused `unconfirmed`, and the commit goes on the same rows hash. The answer carries `cause: "notice_key"`, which the phone shows as its own translated sentence ("That number would answer the notice above the box…"); an older phone shows its generic manual-Send note.

Typed into that box, the digit answers the notice instead of reaching the agent, so the person must see the screen first. Any other text, `10` included, goes on one tap. In a running turn, where Enter would queue the digit after the notice had already taken it, in Replace, which would leave the box holding only the digit, and in an Add to it on a box that is empty by S0, which would do the same, a printed digit is refused with the same cause and the key pad only. With a draft in the box the digit would join the draft, so the ordinary `draft_present` refusal applies. A confirmed notice digit is not counted toward the manual-send cap and adds no line to the lab inbox, since the screen was read, not unreadable; like any probed send that goes out, it still files a sent example.

**The card sends only printed keys.** The notice lifts as a `menu` card with one button per printed key, its label and its digit exactly as printed, in printed order. Its model carries `liveBox`: the card owns no keyboard (`blockOwnsKeyboard` is false), so the composer stays free and no ask is lifted. While the box holds a draft the buttons are off, because a digit would join the draft. A tap sends the digit bound to a region running from the notice's head row down through the input box's bottom border, so the bridge refuses a tap on a notice that has gone and on a box that gained text after the card was drawn; the phone's own fresh-model check refuses a draft too. The card lifts only where that region ends inside the bridge's tail window, so with six or more status rows under the box no card lifts and the pane shows the screen instead.

**A footer run the profile names is not counted against that window.** Claude Code's agents panel stands under the statusline, one row per background agent, so three agents put the region past six rows while nothing about the notice or the box has changed. claude.json names the panel's rows (`idle.volatile.below.footerRows`: `● main`, `◯ <agent>`, `↓ N more`, `↓ to manage`, and the `↓ to view` hint on the mode row), and the input frame lists the rows it finds in `frame.volatile.named`. The phone's notice detector (`detectAbovePromptNotice`) counts the rows under the box only down to the first named row. The bridge (`matchText`) and the conformance legs that mirror it cut the read at that row only when the uncut read is refused `not_in_tail`, then judge again, and the first verdict stands when the cut leaves the region unfound or still outside the tail. Only a profile that declares `footerRows` can name a run, so the bridge, which does not know the pane's harness, asks only those profiles. The two sides agree on a notice, whose region runs through the box's bottom border and so always ends above the named run. The frame's generic footer (`frame.volatile.footer`, any short run of rows after a blank row) is never cut: plain output left under a Claude frame that has exited would pass as one and let a stale digit tap bind. So a blank row and four to eight output rows under the box still refuse, and so do six plain status rows. The bridge's cut is conditional so that it can only turn a `not_in_tail` refusal into a binding: a region inside or under the named run keeps the uncut verdict.

**The digits are outside ADR 0009's numbered-row ban.** ADR 0009 forbids a digit inferred from a numbered list row, because in the `/model` picker a digit confirms and persists. These digits are the keys the notice's own row prints as `<digit>: <label>`: no key is synthesised. The conformance suite holds a notice card to that: each key is a digit its key row printed, `composerReady` is true, and a row spliced between the key row and the box lifts no card.

**The tail-anchoring check exempts a notice card.** That check appends ordinary output under a fixture and expects no card. Under a live box, the frame walk reads output rows as status rows, so the notice still lifts there. The exemption is safe for two reasons. The card lifts only with Claude's live input box found under it, and only while its bound region ends inside the bridge's tail window, so once output pushes the box out of that window no interactive block lifts at all. And its tap is bound to the notice and box rows by the prompt-binding check, so a tap on a notice that has gone is refused rather than typed.

**The notice's rows are left out of every cue read**, the frameless whole-screen read included, so a turn running under a notice reads `running` with an empty box and a plain send queues on one tap. The band above the box that the cue reads walk is counted up from the notice's first row, so a dialog drawn above a tall notice still reads as a modal, and the phone lifts no notice card on that screen.

## Consequences

A screen with the notice reads free, and sends that are not one of its digits go on one tap. The notice's own answer is one tap on the card. A head the plugin draws in another word, or a key row with any other item, falls back to the strong cue and the manual Send, which fails closed.

## Addendum — 2026-10-19: the rating survey is a second notice shape

Status is unchanged. On 2026-10-19 every send to a Claude Code 2.1.303 pane on lane 8788 was refused `unconfirmed`, with the screen read as `modal: "unreadable"`, until the session rating survey went away. The lane's refusal record (`~/.local/state/collie-next/surface/examples/01792385882274-refused-2026-10-19-09d71f6524a96b-unconfirmed.json`) shows the screen: `● How is Claude doing this session? (optional)`, its key row `1: Bad    2: Fine   3: Good   0: Dismiss`, and right under it, with no blank row, the right-aligned `✔ Update installed · Restart to update` row on the box's top edge. The single-key cue read the key row, so every send took the two-tap manual Send.

The owner ruled that the survey must not block sends, and that the phone shows it as a card. So the survey is a notice like Heads up. `idle.notices` names its head row by the whole text, the `●` glyph and the `(optional)` tail included, so an agent's own `●` row that only mentions the survey is no head. `idle.noticeGaps` names the update row, so the reader skips it like a blank row, with or without a blank row next to it. All the rules above apply unchanged: the reader takes only the exact shape over the box, a sentence goes on one tap, a send of exactly `0`, `1`, `2` or `3` takes the manual Send with `cause: "notice_key"`, and the phone shows a card with the four printed keys (Bad, Fine, Good, Dismiss).

## Addendum — 2026-10-20: the plugin's follow-ups are notices

Status is unchanged. Pressing a key on the Heads up notice moves the plugin to a follow-up, and Claude Code 2.1.304 draws two of them over the same live box. On 2026-10-20 both read `modal: "unreadable"` and lifted no card, so the phone skipped them and every send took the two-tap manual Send. The owner asked that the phone show them.

After Dismiss (and after Learn more, then Dismiss), the plugin draws one row, `✦ Dismissed.   1: That was helpful   2: Not relevant   3: Couldn’t understand   4: Turn off suggestions   0: Dismiss`. Its head and keys share a row. On a narrow pane the keys wrap onto rows indented by two spaces, and the last wrapped row can hold a single key. After Learn more, it draws the Heads up head again, then a blank row, an explanation body indented by two or more spaces, a blank row, and `1: Understood   2: Chat in main session   0: Dismiss`.

The reader takes both shapes, in two named and fail-closed ways:

- **The key block may wrap, and the head may carry it.** The keys sit on one to six rows, each wrapped row indented by exactly two spaces and holding only `<digit>: <label>` items. The block's items, joined, must still be a key row the modal cues would read. A head row the profile names whose text after the head is such items is the block's first row.
- **A body only under a head that declares one.** `idle.notices` gains `body: true`. Under such a head, the continuation rows may be followed by up to sixty rows, each blank or indented by two or more spaces, and none a key row. The card shows those rows as a mirror under its title. A head without `body`, the rating survey included, keeps the exact shape above.

claude.json names the Dismissed head (`^✦ Dismissed\.`) and marks the Heads up head `body: true`.

Nothing else changes. These keys act on a box holding one digit, like the offer's: the follow-up's own digit typed into the empty box answered it in the live check. So the box stays free, a sentence goes on one tap, and a send of exactly one printed digit takes the manual Send with `cause: "notice_key"`. The card's buttons are the printed digits in printed order, and its tap is bound from the head row through the box's bottom border.

A follow-up whose rows break these shapes still falls back to the strong cue and the manual Send. That includes the plugin's error row and its learning-page row, which no capture holds yet.

## Addendum — 2026-10-21: the survey's transcript question has letter keys

Status is unchanged. After a key on the rating survey, Claude Code 2.1.306 asks a second question over the same live box: `● Can Anthropic look at your session transcript to help us improve Claude Code?`, a `Learn more:` row with the docs link, and the keys `y: Yes    n: No     d: Don't ask again`. On 2026-10-21 every phone send to such a pane was refused `unconfirmed` with `modal: "unreadable"` until the question was answered at a keyboard, because the reader took digit keys only. The 2.1.306 bundle reads these letters through the same hook as the survey's digits: a key acts only when the box's whole value is that letter, lowercased first.

So letters join the notice shape in one named and fail-closed way:

- **Letter keys only under a head that declares them.** `idle.notices` gains `letters: true`. Under such a head the key block is read as `<letter>: <label>` items, one letter each, and a block of digits no longer reads there; a `letters` head never carries keys on its own row. Every other head reads digits only, as before, so a letter key under it still falls back to the strong cue. The conformance suite holds a card to the same rule: digits, or letters under a `letters` head, each printed.
- **The bridge matches a send case-insensitively.** Claude Code lowercases the box before it matches a letter, so a send of exactly `Y` would answer the question as `y` does. `answersNotice` compares lowercased text; digits are unaffected. The refusal sentence says "message" rather than "number", since the key may be a letter.
- **A first line that is a key counts as the key.** The bridge writes a send one line at a time, so a send whose first line, trimmed, is a printed key leaves that key alone in the box until the newline key follows it, and the notice may take it. `answersNotice` matches such a send too, letters and digits alike, so it takes the same manual Send and the same key-pad refusals as the key alone. Once confirmed it is typed in full on the ordinary path: S1 must find the whole text in the box, so if the notice took the first line, no Enter follows. A first line such as `yes` or `y.` is an ordinary message.

claude.json names the transcript question with `letters: true`. The update-row gap also takes 2.1.306's wording, `Restart to apply`, and since 2026-10-31 2.1.314's `/restart to apply`, which it prints where it offers the `/restart` command.

The card sends a printed letter in one tap, as it sends a printed digit. These keys carry weight: `y` lets Anthropic read the session transcript, and `d` turns the question off for good. They are still the harness's own printed answers to its own question, the same as a keyboard user's one key press, so no confirm step is added. A send of one of the letters in the composer takes the manual Send, as a digit does.

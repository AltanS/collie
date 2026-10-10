# 0010 — Long sends are verified via the paste placeholder, not by chunking them

Status: **Accepted** (2026-08-06)

## Context

The #34 guard presses the submit key only once it can SEE the typed text on the agent's `❯` line
(`web/src/lib/reply-action.ts`). That match is a literal one: the visible draft has to be a slice of
what we sent.

Claude Code has a paste heuristic that defeats it. Anything past roughly 400 characters — multi-line
or not, certainly by ~1KB — is collapsed in the input box into a token of Claude's own:

```
[Pasted text #3]              a paste with no newline in it
[Pasted text #3 +3 lines]     M = the number of `\n` characters in the paste (60 lines → +59)
```

So the box never holds our words, the match never fires, and the send stalls: *"Message didn't reach
the input box…"*. Enter is correctly withheld — but the message is now **un-sendable**, because every
retry sweeps the stranded placeholder, re-types, collapses again, and stalls again. Reproduced live
(2026-08-06, pane `w2H:p1`, three attempts ending at `[Pasted text #3 +3 lines]`).

Probed on a real pane the same day (collie-demo sandbox, Claude Code current):

- Short pastes (≤ ~400 chars observed) insert **literally**, newlines included, and verify today.
- `M` is exactly the count of `\n` in the paste. `N` is a **session-scoped counter we cannot
  predict**, so a leftover token from somebody else's paste is indistinguishable from ours by shape.
- A PTY chunk split can leave `placeholder` + a literal tail in one draft
  (`[Pasted text #1 +3 lines]xxxxx… four`); rapid consecutive chunks usually merge into ONE token
  carrying the total.
- The token wraps arbitrarily in the box, and `extractInputDraft` space-joins wrapped rows, so a wrap
  can fall mid-token (`…+3 li` / `nes]`).
- One Backspace deletes a placeholder atomically; the existing pre-clear sweep (ctrl+k + N
  Backspaces) already clears every observed shape.

## Decision

**Recognise the placeholder as send evidence, when it is consistent with the message we just typed.**
An adapter-scoped capability (`draftCarriesSend`, implemented for Claude in
`web/src/lib/harness/claude/paste.ts`) is consulted **only after** the generic literal match has
already failed — it can widen what counts as evidence, never narrow it. It accepts only when: the
draft holds a token AND a collapse is plausible for *our* send (it has a newline, or it is ≥ 700
chars); the tokens claim no more lines than we sent; a fully-collapsed draft claims **exactly** our
line count; and every literal fragment beside the tokens occurs in our text, in order. All matching
runs on a whitespace-stripped normalisation, because of the mid-token wrap. Anything inconsistent is
false, and the caller keeps today's stall — a `true` here fires Enter at a screen we cannot read.

**Do not split long sends into sub-threshold chunks.** The obvious alternative — type ~300 chars at a
time with a pause, so Claude never collapses anything — is rejected:

- the threshold is unversioned Claude-internal behaviour; a release that lowers it silently turns
  every send into a stall again, and nothing tells us it moved;
- `pane.send_text` has no bracketed paste, so a chunk boundary that lands on a lone `\n` **submits**
  the half-written message — the exact class of accident #34 exists to prevent;
- the PTY coalesces rapid chunks anyway (observed: consecutive chunks merging into one token), so the
  pacing does not reliably buy what it costs;
- it re-introduces timing games on a live PTY, which is precisely what #34 removed when it replaced
  the fixed 350ms-then-Enter with read-then-verify.

## Consequences

- A long send is verified by *arithmetic about* our message rather than by seeing it, which is
  strictly weaker evidence. The engage gate (a newline, or ≥ 700 chars) is what keeps a stale token
  from vouching for a short send that never landed; below it, nothing changes.
- The grammar is Claude's, and it lives in Claude's adapter. Another harness gains this the day it
  ships its own `draftCarriesSend`; until then it keeps the stall, which is safe.
- The same token is not the user's text, so the stranded-draft preview keeps **showing** it (the
  screen honestly says that) but withdraws "Take over" — copying `[Pasted text #1 +3 lines]` into the
  composer would make that string the message.
- Claude could change the token's wording, and the fixture
  (`web/src/fixtures/panes/claude--draft-paste-placeholder.txt`) plus `paste.test.ts` are what would
  catch it — a live probe, as in ADR 0009, is what settles any question about the shape.
- Revisit if Herdr grows a bracketed-paste or "type verbatim" mode for `pane.send_text`: with the
  heuristic bypassed, the text would land as text and the generic matcher would verify it directly.

## Addendum — 2026-10-03: a long send to Claude goes as one bracketed paste

Status is unchanged: **Accepted**. Nothing above this line is rewritten. This addendum takes the
revisit the last consequence reserved, without waiting for Herdr: `pane.send_text` writes raw bytes,
so Collie writes the markers itself.

Bare sends lost text. On macOS a PTY hands Claude a long send in ~1,022-byte reads. Claude Code
(2.1.288) makes each read over 800 characters its own paste token, and a short final read then wipes
the earlier tokens, so only the end survived. That tail is a slice of the message, so the literal
match verified it and Enter submitted it. Probed in an isolated herdr 0.9.0 session: 12,029
characters sent bare, 787 received. The bytes themselves arrived intact; the loss is inside Claude.

So the Claude adapter's `bracketedPaste` sends any reply over 800 characters framed as
`ESC[200~ … ESC[201~`, and Claude takes it as ONE paste: all 12,029 arrived, through the phone UI.
At 800 or fewer the send stays bare, since no read can collapse, so a short reply still lands
literally and verifies as before. The framed send always collapses to the token this ADR already
reads, so the evidence rules above are unchanged, with one widening: Claude lifts an image path off
the end of a paste, or off a line of its own, into `[Image #N]`, and `pasteCarriesSend` accepts
that token only while the send holds at least as many upload paths in the shape Collie sends
(an absolute `<state dir>/uploads/<pane>-<time>-<hex>.<ext>` that stands alone on its line or ends
the text). A prose mention of `shot.png` lifts nothing, so it never explains a token.

Chunking stays rejected, for the reasons above.

## Addendum — 2026-10-10: the per-adapter settle floor (#395)

Status is unchanged: **Accepted**. Nothing above this line is rewritten. This addendum records one
named exception to the rule above.

Muse 1.4.4 swallows an Enter sent within about 60 ms of the text (#395). The guarded send therefore
holds the submit until an adapter-declared floor has passed since the last type call
(`submitSettleMs`, `lib/reply-action.ts`). Muse declares 350 ms. Every other adapter declares none
and sends as before. This is one named exception to the rule above, measured on one harness, not a
return of the fixed pacing #34 removed.

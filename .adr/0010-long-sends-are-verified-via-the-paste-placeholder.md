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

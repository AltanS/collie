# 0009 — A generic menu is driven by the keys it names, never by digits

Status: **Accepted** (2026-08-05)

## Context

Claude Code's `/model` picker is a full-screen modal that no Collie grammar recognised. Its footer
reads

```
Enter to set as default · s to use this session only · Esc to cancel
```

which `classifyFooter` does not claim, so no detector lifted it: Collie showed no buttons,
`dialogPresent` stayed false, and a composer send typed the user's message straight **into the
picker** before reporting a confusing "stalled" error. The picker is not an AskUserQuestion dialog,
it will not be the last screen of its kind, and capturing each one by hand as it ships is not a
strategy.

The generic move is to read the footer: a `·`-separated list of `<key> to <verb>` hints is the
screen **naming its own keys**, which is the one thing about an unknown modal we can trust. That
gets us buttons for `Enter`, `s` and `Esc` without knowing what the screen means.

The tempting extra step is digits. Every row is numbered `1.`–`5.`, prompt-select already turns
numbered rows into digit buttons, and the rows are right there. Live-probed on a real pane
(tmux + Claude Code, 2026-08-05), pressing a digit in the `/model` picker:

> Set model to Haiku 4.5 **and saved as your default for new sessions**

One tap confirms *and* writes the user's default for every future session. `s` acts on the
`❯`-highlighted row for this session only; `Enter` sets the default; `Esc` cancels — all three
announced, all three reversible in the sense that the user asked for them. The digit's second effect
is announced nowhere in the UI it appears in, and Collie cannot know which unknown modal has one.

The reply path has a related gap. `sendGuardedReply` types the text and *then* verifies it landed —
enough to stop Enter answering a dialog (#34), not enough to stop the text being deposited in one.

## Decision

**A generically-detected menu emits only keys the screen printed, plus arrows it advertised.** The
footer's `<key> to <verb>` hints become buttons; a `❯` row enables Up/Down; an `←/→ to <verb>` row
enables Left/Right. Anything else — most importantly a digit inferred from a numbered row — is never
synthesised. The ban lives in the grammar (`menuKeyFor` has no digit branch), not in the key
validator, because a digit *is* a valid Herdr key; what is unsafe is inventing one.

**The generic grammar runs last.** Preview-select, wizard, multi-select and prompt-select each
encode a verified keystroke recipe for a dialog they recognise. The generic detector claims only what
all four declined.

**An unrecognised modal refuses composer typing.** The reply path gains an adapter-scoped pre-flight
(`composerReady`): one read before `send_text`, and if the adapter cannot find an input box, nothing
is typed at all. A second Send overrides it deliberately — and still runs the type-then-verify guard,
so the submit key is never fired blind even under the override.

## Consequences

- Driving an unknown picker takes more taps than a digit would: arrow to the row, then the footer's
  key. That is the intended trade — the digit's saving is one tap, its cost is an unrequested,
  unannounced, persistent change.
- A screen with no key-hint footer, or none of whose hint keys are sendable, gets no buttons. The raw
  mirror and the Keys pad still drive it; that is the pre-existing behaviour, not a regression.
- The pre-flight costs one extra pane read per send on adapters that implement `composerReady`. It
  fails **open** — no adapter, or a read that throws, keeps today's behaviour.
- Revisit if Herdr ever exposes structured menu state, or if a Claude release makes a digit
  non-persistent *and* says so on the screen. A live probe, not a changelog line, is what would
  settle it — the probe above is the format.

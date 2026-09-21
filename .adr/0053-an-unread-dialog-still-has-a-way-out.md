# 0053 — An unread dialog still has a way out

- **Status:** Accepted
- **Date:** 2026-09-21
- **Shipped in:** pending (M34, target 1.12.0)
- **Trail:** `web/src/lib/harness/claude/markers.ts` (`classifyFooter`) ·
  `web/src/lib/harness/claude/menu.ts` (`detectMenuRegion`) ·
  `web/src/lib/harness/claude/effort.ts` · `web/src/lib/harness/index.ts` (the post-pass) ·
  `web/src/lib/harness/types.ts` (`HarnessAdapter.cancelKey`) ·
  `web/src/lib/harness/dialog-contract.ts` · `web/src/lib/blocks.ts` (`UnreadDialogBlock`) ·
  `web/src/components/composer.tsx` · `web/src/lib/harness/claude/claude-lab-corpus.json` ·
  [ADR 0009](./0009-a-generic-menu-is-driven-by-the-keys-it-names.md)

## Context

**One phrase in a footer took every button off the screen.** On 2026-09-21 Claude Code turned
`/effort` into a slider: a `▲` marker on a rule over a row of labels, and a footer reading
`←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel`. Four keys, named by the
screen itself. Collie offered none of them.

Every numbered-prompt grammar declined, correctly: the screen has no numbered options. The generic
menu grammar exists for exactly this case, and its whole contract is "the screen names its own keys"
([ADR 0009](./0009-a-generic-menu-is-driven-by-the-keys-it-names.md)). It stood down because
`classifyFooter` saw the words "enter to confirm" and filed the slider as Claude's folder-trust
prompt, and `menu.ts` treats any `classifyFooter` claim as "a specific grammar owns this screen".
Nothing owned it. The classifier was reading one line and answering a question about a whole dialog.

**The failure was worse than no buttons.** The app derives "a dialog is on screen" from the blocks it
built. Raw blocks own no keyboard, so `dialogPresent` stayed false, the composer stayed unlocked, and
a send would have typed the operator's message into the picker. The only way out was Esc pressed by
hand inside the Keys keypad. That is the same failure ADR 0009 was written to end, arriving through a
different door: not "no grammar exists", but "a grammar was silenced".

**The capture was already on disk and could not speak.**
`claude-lab--menu-effort-slider--w82.txt` had sat in the 64-entry capture-lab corpus since
2026-09-17, its own notes reading "a `───` slider row with `▲` marker, no numbered options, key-hint
footer". The corpus could not catch the bug, because each entry records only whether an input box is
found, what draft and tail are read, and whether a dialog is live. It never records which BLOCK the
pipeline should lift. Proving Collie will not type into a screen is a different claim from proving
Collie can drive it: eight of the corpus's fifteen live-dialog captures come back raw today, and the
corpus is content with all eight.

**There will be another one.** Claude Code ships screens faster than Collie writes grammars, and the
corpus was four patch releases behind the machine it was captured on when the slider hit. A grammar
per screen is the work; it is not a plan for the gap between screens.

## Decision

**Two rules, and one card that is not a grammar.**

1. **A footer phrase never silences a grammar.** A family classifier that another grammar consults as
   "somebody else owns this screen" must be answerable from the dialog it names, not from one line
   any screen may print. Claude's `classifyFooter` may claim the trust family only with the trust
   dialog's own title or body evidence on screen, never on "enter to confirm" alone. The generic menu
   then catches the slider, and a Claude-specific Effort detector, running before the generic one,
   reads the current value from the `▲` column and emits the existing `MenuModel` so the existing
   renderer, identity comparator and race guard all apply unchanged.

2. **An unread modal still gets its adapter's declared cancel key.** When an adapter's blocks are
   raw-only, its `composerReady` answered a definite `false`, the screen is non-blank, and the
   adapter has DECLARED a cancel key, a post-pass outside every adapter emits an `unread-dialog`
   block: one button, that key, over the raw mirror, under the caption "Collie cannot read this
   dialog".

**The card is not a grammar, and it does not extend ADR 0009's confidence bar.** ADR 0009 licenses
buttons on the strength of a screen naming its own keys, read off that screen. The card reads nothing
off the screen. Its key comes from a per-adapter declaration written by whoever knows the harness,
checked against that harness's own captures, reviewed once. The card's claim is narrower than a
grammar's, not broader: it says "this harness has a way out of its modals and here it is", never
"this screen means X".

**No footer-dialect parsing in the card, deliberately.** Reading each harness's footer dialect to find
its cancel key would be a second classifier deciding what a screen is from one line, which is the bug
class that just shipped. A declaration cannot be fooled by a phrase.

**The declared keys** (each read from that harness's own fixtures or notes):

| Adapter | Key | Evidence |
|---|---|---|
| claude | `Escape` | every Claude modal footer that names a way out prints `Esc to cancel` |
| codex | `Escape` | `codex/APPROVAL_NOTES.md`: `Press enter to confirm or esc to cancel` |
| muse | `Escape` | `muse/DIALOG_NOTES.md`: `Esc to interrupt`, and `Esc to go back` in the review phase |
| agy / antigravity | `Escape` | same two registrations, same footers |
| grok | `ctrl+c` | `grok/PERMISSION_NOTES.md`: `Ctrl+c:cancel │ Esc:scrollback`, Escape opens the scrollback view |
| omp | none | gap, below |

Grok is the reason the key is declared rather than assumed. On grok, Escape is not the way out.

**The omp gap.** omp's modals do print `Esc close` / `Esc cancel`, so the key is not the problem. Its
composer is located by a scanner whose false-negative mode is total and permanent: one ZWJ emoji in a
statusline template and `locateComposer` returns null on every frame, leaving `composerReady` false
forever on a pane with no dialog on it. A card gated on `composerReady === false` would, in exactly
that state, paint itself permanently over a live composer. omp declares nothing until that floor is
trustworthy, and a missing declaration means no card, per adapter, by construction.

**The card owns the keyboard, and keeps the type-anyway override.** It takes a row in the dialog
contract, so `blockOwnsKeyboard` is true, so the composer refuses a free-text send. That refusal is
the point: on the slider the app believed nothing was open. But the card's four conditions are
heuristics about an unknown screen, and a splash, a cleared buffer or an alt-screen tool can satisfy
all four. So the composer's refusal for this kind arms the deliberate second-tap override that the
reply path's pre-flight already has (ADR 0009's "A second Send overrides it deliberately"), and the
status line names the declared key. A false positive costs one extra tap, never a locked composer.

**The corpus becomes a contract.** Every capture-lab entry declares the block kind a correct pipeline
would lift, and the keys where the screen is interactive. One invariant runs across all of them: no
input box, plus a last line that parses as a key-hint footer, plus a raw-only result, is a failure.
Screens that stay raw today are listed with a reason and a named candidate grammar, never silently
accepted. A standing ritual, keyed to the Claude Code version on the dev machine, re-runs the lab and
files every new or changed screen before the next Collie release.

## Consequences

- **The trust classifier gets more expensive and less quotable.** It can no longer answer from one
  string, so its tests assert about a dialog rather than about a line. That is the cost of the rule,
  and it is paid once.
- **A screen that fools all four conditions shows a card that does nothing useful.** Its button sends
  a key the screen may ignore. The raw mirror is still there, the Keys pad is still there, and the
  composer is one deliberate second tap away. This is strictly better than the state it replaces,
  where the composer was silently open onto a modal.
- **The card can mislead by being reassuring.** "Collie cannot read this dialog" plus one button
  reads like a considered offer, and on muse's review screen the key steps back rather than
  dismisses. The caption must not promise "cancel", only name the key.
- **Every new adapter now has one more thing to declare**, and declaring nothing is a supported
  answer with a visible cost. The tier ladder in `HARNESS_CONTRIBUTING.md` gains a row.
- **The corpus's invariant will go red on a future Claude release**, by design. That is the feature.
  The cost is that a release cut against a fresh Claude version may need a corpus pass first.
- **Revisit** if a harness ships a modal with no way out at all, if a declared key is observed to be
  destructive on some screen of its own harness, or if the card's four conditions are seen firing on
  a pane whose composer is demonstrably live. Any of those is a live observation, not a changelog
  line, and the 2026-09-21 incident is the format: a screen, a capture, and what the operator could
  and could not do.

Credit for finding this belongs to the operator, who hit the `/effort` slider live on 2026-09-21 and
had no way out of it but the Keys keypad.

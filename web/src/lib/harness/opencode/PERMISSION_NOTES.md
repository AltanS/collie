# OPENCODE PERMISSION NOTES

The measured ground truth for the opencode permission dialog — the Tier-2 lift in
`harness/opencode/`. Every claim below was probed a keystroke at a time against **opencode 1.18.32**
in private Herdr sessions, 2026-09-26, and is pinned by the fixture corpus
`web/src/fixtures/panes/oc--*.txt` (captured the same day, listed in `web/src/fixtures/panes/README.md`).
The dialog lift itself came from @Gabrielribeiroic (#255); the corpus and this file were redone on
1.18.32, the newest release.

## Where the dialog paints

Inside the composer's own bar run, in place of the composer's bottom: no model row, no rule. The
bar (`┃`, U+2503) turns ORANGE for the dialog's rows while it is blue elsewhere — the colour is a
theme value and nothing keys on it, but it is why the dialog reads as part of the box:

    ┃  △ Permission required          <- the title, U+25B3 in the warning colour
    ┃    # Shell command              <- a heading: `# Shell command`, `→ Edit <file>`,
    ┃                                 <-   `% WebFetch <url>`
    ┃  $ echo fixture-corpus-probe    <- the body; an edit dialog paints its diff rows here, a
    ┃                                 <-   webfetch dialog `URL: <url>`
    ┃   Allow once   Allow always   Reject  ctrl+f fullscreen  ⇆ select  enter confirm
    ┃                                 <- a bare-bar row, then the buffer's end

The card's question is the first paragraph under the title that says what is asked. A `# ` heading
names only the kind of request, so the paragraph under it is the question (`$ echo …`); any other
heading names the subject itself and is the question (`→ Edit probe.txt`, `% WebFetch …`). On the
second step the question is its sentence (`This will allow the following patterns until OpenCode
is restarted`), joined across rows where a narrow pane wraps it.

An edit with a long diff keeps the same box height and scrolls the diff inside it (a 40-line file
showed 7 diff rows and a scrollbar at a 40-row pane), so the title stays within the lift's bound.

Two footer shapes, both ending at the buffer tail:

- **wide** — the option chips and the hint pair (`⇆ select  enter confirm`) share ONE row; the
  option row is the footer row itself.
- **narrow** (50 columns measured) — the chips sit on a row of their own, the hints paint a row
  below them, and a bare-bar row separates them.

## The recipe (probed)

Probed one key at a time on **opencode 1.18.32**, 2026-09-26, in private Herdr sessions with a
scratch config (`OPENCODE_CONFIG` pointing at a file that asks for `bash`, `edit` and `webfetch`).

| Act | Keys | Evidence |
| --- | --- | --- |
| Choose the option the pointer is on | `Enter` alone | the chip rides the pointer. `Enter` on `Reject` rejects in one step: the file was not written, the turn ended |
| Move the pointer right one | `Right` | the chip moved to the next option |
| Cycle past the last option | `Right` at `Reject` wraps to `Allow once` | the wrap is why keys are computed as a forward offset |
| Move the pointer left one | `Left` | moves, and wraps from `Allow once` to `Reject`. The adapter never sends it: forward-with-wrap reaches every option |
| `Tab` | does NOTHING to the pointer | the chip stayed put. The `⇆` hint means the arrow pair, not Tab |
| A digit | never sent | the dialog prints none (.adr/0009) |
| `Allow always` + `Enter` | opens a second step, `△ Always allow`, with `Confirm` / `Cancel`, pointer on `Confirm` | the body names the patterns (`- echo *`) for bash, and only the permission for edit |
| Second step: `Right` | moves to `Cancel`, and wraps back to `Confirm` | same chips, same arithmetic, so the same lift |
| Second step: `Confirm` + `Enter` | allows the pattern until opencode restarts; the command ran | `echo always-probe` printed its output |
| Second step: `Cancel` + `Enter` | back to the first step, pointer on `Allow once` | nothing was allowed |
| `Escape` on the second step | back to the first step, pointer on `Allow once` | |
| `Escape` on the first step | closes the dialog and rejects the request; the turn ends | bash and webfetch, nothing ran |

Every option's `keys` are computed from the pointer the screen currently shows: offset `d` forward
(with wrap) then `Enter` — the option AT the pointer is `["Enter"]`, one at `d` is
`["Right" × d, "Enter"]`. Two reasons, one per field: no digit is ever synthesised (.adr/0009), and
a derivation always matches the screen the user is looking at, so a tap against a stale render
fails `promptsEqual` (it compares every option's exact plan, because the text of the dialog is the
same with the pointer on any chip) and re-derives instead of mis-typing. The
pointed row's badge is therefore `⏎` and every other row's is `→`, the way ADR 0055 draws a
pointed list.

A tap is walked, verified, then confirmed (ADR 0080), sideways here: `Right` × d goes out bound to the
tapped screen, then Enter once a fresh read shows the tapped chip as the pointed one. The pointer is a
background colour, so the bridge's text binding is the same string with the pointer on any chip. It
cannot see the pointer. The verify read on the phone is the guard, and the window that remains runs
from that read to the send. The corpus pairs are `oc--permission-bash.txt` with `--moved`, `--reject`
and `--wrap`, `oc--permission-edit.txt` with `--moved`, and `oc--permission-always-bash.txt` with
`--cancel` (`harness/walk-pairs.ts`).

The second step is lifted as its own dialog: its title differs, so its signature and identity
differ, and a tap on one step never fires on the other. Its buttons walk and confirm exactly as the
first step's do.

`Escape` is the adapter's declared `cancelKey`: on a screen no grammar reads (a picker), the
unread-dialog card offers it and nothing else (.adr/0053). `modalOnScreen` asks for a picker or a
dialog footer at the tail first, so the card never stands over the shell while opencode starts or
exits.

## What the pointer looks like

A BACKGROUND-COLOUR chip on exactly one option: the active chip paints its label in the row's dark
text colour ON the accent background, the other options sit on the dialog's base background — the
same background the footer paints its `⇆ select` hint on. The detector reads that hint's background
as the base and requires exactly ONE option off it. A plurality of chips cannot serve as the base:
the second step has two chips, and one of them is always the pointer. None off the base, or two,
means the pointer is not derivable and the dialog refuses to lift (fail-closed). No colour name
anywhere; the rule is relative, so a different theme keeps working as long as the active chip
differs from the hints' background.

The active chip also pads itself (` Allow once ` with the flanking spaces INSIDE its background) —
the tokens are split on the row's 2+-space runs, so the chip's label reads as one token whose style
is its own. The hints (`ctrl+f fullscreen`, `⇆ select`, `enter confirm`) are separated from the
options by SHAPE (they open with a key token: `ctrl+`, `⇆`, `enter `, `esc`, `shift+`) — measured
that they share the options' text foreground, so STYLE alone cannot separate them.

## The composer gate (why `composerReady` matters here)

The dialog lives INSIDE the composer's bar run, so the composer's own tail scanners see it. What
saves the reply path: the dialog replaces the composer's bottom — its footer is a BAR ROW under the
rule's position, so the scanner's status-walk hits a bar row before the rule and refuses. The
destructive pre-clear sweep and every reply therefore refuse to type while the dialog is up, and
the dialog's buttons carry the keys instead.

A picker (the ctrl+p command palette, `/agents`, `/models`, …) floats over the screen while the
composer's tail stays intact — the tail alone answers `true` on a screen the picker owns. Every
picker shares one frame: a title followed by the `esc` hint, and one or two rows below it a `Search`
row whose word starts in the title's column (`pickerOverlayUp` in `chrome.ts`). That shape is the
predicate that refuses it; no picker title is named. Once a filter is typed, `Search` is replaced
by the filter and the check misses the picker (a known gap; the submit key stays withheld).

## The spinner

A running command paints a braille spinner (`⠼`…) on its own `┃` block in the transcript, ABOVE the
dialog, and the status row under the composer animates (`⬝⬝⬝■■■  esc interrupt`). The dialog's
signature starts at its title and ends at its footer (the bridge's binding window), so it never
churns with either. Nothing needed normalising — the exclusion is positional.

## What is NOT lifted

- The pickers (the ctrl+p command palette, `/agents`, `/models`, …) — the palette's hints are
  two-key sequences (`ctrl+x n`) the shared menu-hint grammar rejects, and no picker carries a
  footer recipe the grammar can name. Raw mirror, a locked composer, and the unread-dialog card
  with Escape, which closes a picker.
- The slash palette (`/`) — composer chrome, stripped along with the box; Collie's own opencode
  catalog replaces it (`lib/agent-commands.ts`, already shipped).
- The agents cycle (`tab` on 1.18.32) — not a dialog; it swaps the composer's agent row
  (Build → Plan).

## Open questions / limits

- `bash`, `edit` and `webfetch` dialogs are captured. Other permission types presumably share the
  shape — the lift keys on the title row and the footer hints, not on the tool name — but no
  fixture proves it yet. A mis-detected shape falls to raw, and the unread-dialog card offers
  Escape, which declines.
- Panes taller than 40 rows were not measured. If the box grows with the pane, the title may sit
  more than 16 rows above the options, the lift refuses, and the card offers Escape.
- On 1.18.32 the body does not change with the pointer; the patterns show on the second step. The
  identity comparison keys on the whole region either way, which is what makes a stale tap refuse.
- A user draft that literally begins with opencode's placeholder text ("Ask anything…") reads as an
  empty box to the draft probe. Cost: a stalled send, never a wrong Enter.

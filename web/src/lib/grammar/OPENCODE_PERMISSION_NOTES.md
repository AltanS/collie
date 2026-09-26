# OPENCODE PERMISSION NOTES

The measured ground truth for the opencode permission dialog — the Tier-2 lift in
`harness/opencode/`. Every claim below was probed a keystroke at a time against **opencode 2.0.8**
(Go TUI) in a sandbox pane on the t480 crew member, 2026-09-20, and is pinned by the fixture corpus
`web/src/fixtures/panes/oc--*.txt` (captured the same day, listed in `web/src/fixtures/panes/README.md`).

## Where the dialog paints

Inside the composer's own bar run. The bar (`┃`, U+2503) turns ORANGE for the dialog's rows while
it is blue elsewhere — the colour is a theme value and nothing keys on it, but it is why the dialog
reads as part of the box:

    ┃  △ Permission required          <- the title, U+25B3 in the warning colour
    ┃                                 <- bare-bar padding (the box interior is padded tall)
    ┃  $ echo fixture-corpus-probe    <- the subject; an edit dialog paints `→ Edit <file>` and
    ┃                                 <-   its diff rows here instead
    ┃                                 <-   (nine blank rows between subject and options, measured)
    ┃   Allow once   Always allow   Reject  ctrl+f fullscreen  ⇆ select  enter confirm
    ┃                                                     <- a bare-bar row + the status row below
    <status row>

Two footer shapes, both ending at the buffer tail:

- **wide** — the option chips and the hint pair (`⇆ select  enter confirm`) share ONE row; the
  option row is the footer row itself.
- **narrow** (pane ≈ 95 columns) — the chips wrap onto a row of their own, the hints paint a row
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
fails the identity comparison (the keys are part of it) and re-derives instead of mis-typing. The
pointed row's badge is therefore `⏎` and every other row's is `→`, the way ADR 0055 draws a
pointed list.

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

The working state paints a braille spinner (`⠙`…) and its running-command row INSIDE the bar run,
ABOVE the title. The dialog's signature starts at the title, so it is byte-faithful, ends at the
footer (the bridge's binding window), and never churns with a spinner frame. Nothing needed
normalising — the exclusion is positional.

## What is NOT lifted

- The ctrl+p command palette — its items' hints are two-key sequences (`ctrl+x n`) the shared
  menu-hint grammar rejects, and its rows carry no footer recipe the grammar can name. Raw mirror +
  keys pad, the omp precedent.
- The slash palette (`/`) — composer chrome, stripped along with the box; Collie's own opencode
  catalog replaces it (`lib/agent-commands.ts`, already shipped).
- The agents cycle (`shift+tab`) — not a dialog; it swaps the composer's agent row (Build → Plan).

## Open questions / limits

- Only `bash` and `edit` dialogs are captured. Other permission types (webfetch, …) presumably
  share the shape — the lift keys on the title row and the footer hints, not on the tool name —
  but no fixture proves it yet. A mis-detected shape falls to raw, not to a keystroke.
- On 1.18.32 the body does not change with the pointer; the patterns show on the second step. The
  identity comparison keys on the whole region either way, which is what makes a stale tap refuse.
- A user draft that literally begins with opencode's placeholder text ("Ask anything…") reads as an
  empty box to the draft probe. Cost: a stalled send, never a wrong Enter.

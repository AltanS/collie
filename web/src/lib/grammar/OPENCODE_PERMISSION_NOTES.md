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

| Act | Keys | Evidence |
| --- | --- | --- |
| Choose the option the pointer is on | `Enter` alone | the chip rides the pointer |
| Move the pointer right one | `Right` | probed: the chip moved to the next option |
| Move the pointer left | `Left` | never probed — the recipe never needs it (see below) |
| Cycle past the last option | `Right` at `Reject` wrapped to `Allow once` | probed; the wrap is why keys are computed as a forward offset |
| `Tab` | does NOTHING to the pointer | probed; the chip stayed on `Allow once`. The `⇆` hint means the arrow pair, not Tab |

Every option's `keys` are computed from the pointer the screen currently shows: offset `d` forward
(with wrap) then `Enter` — the option AT the pointer is `["Enter"]`, one at `d` is
`["Right" × d, "Enter"]`. Two reasons, one per field: no digit is ever synthesised (.adr/0009), and
a derivation always matches the screen the user is looking at, so a tap against a stale render
fails the identity comparison (the keys are part of it) and re-derives instead of mis-typing.

Left was never probed. The adapter never emits it: forward-with-wrap reaches every option from
every pointer state, so nothing in the recipe needs it.

## What the pointer looks like

A BACKGROUND-COLOUR chip on exactly one option: the active chip paints its label in the row's dark
text colour ON the accent background, the other options sit on the dialog's base background. The
detector requires the PLURALITY background among the option tokens, then exactly ONE option off it —
two odd chips mean the pointer is not derivable and the dialog refuses to lift (fail-closed). No
colour name anywhere; the rule is relative, so a different theme keeps working as long as the
active chip differs from the base.

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

The ctrl+p command palette floats over the box's middle while the composer's tail stays intact —
the tail alone answers `true` on a screen the palette owns. Its header stack ("Commands" with the
"esc" hint, "Search", "Suggested" as exact rows) is the predicate that refuses it.

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
- The subject row under the title CHANGES with the pointer state (hovering `Always allow` swaps the
  command row for "This will always allow the following patterns…" + the pattern list). The lifted
  question is therefore per-pointer-state; the identity comparison keys on the whole region, which
  is exactly what makes a stale tap refuse.
- A user draft that literally begins with opencode's placeholder text ("Ask anything…") reads as an
  empty box to the draft probe. Cost: a stalled send, never a wrong Enter.

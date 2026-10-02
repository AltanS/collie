# omp `/resume` picker: keystroke recipe

The choreography notes file the Tier-2 bar asks for (`HARNESS_CONTRIBUTING.md`), for the one omp
screen the adapter lifts ([ADR 0076](../../../../../.adr/0076-the-omp-resume-picker-is-lifted-and-every-omp-modal-has-a-way-out.md)).
Grammar: `resume.ts`. Corpus: `omp--menu-resume*.txt` (omp 17.2.12, 2026-08) and
`omp--v18-4-resume*.txt` (omp 18.4.10, 2026-10-02).

## What the screen prints

omp 18.4.10, boxed (the pane here is 109 columns by 59 rows; the box fills it):

```
╭─ Resume Session (current folder) ─────────────────────────╮
│                                                           │
│ > ab                                                      │   search row, `>` and the typed text
│                                                           │
│ ❯ Render Fancy Content in Terminal                        │   title row, pointer in column 2
│   lets push the boundaries here abit and render some …    │   first-prompt row (free text)
│   7 minutes ago  ·  138.1KB  ·  current  ·  ✔ done  ·  ⑂ fork   meta row
│                                                           │
│   Render Fancy Content in Terminal                        │
│   …                                                       │
│                                                           │   blank rows down to the footer
│ [⌦/⌫ delete · ⏎ select · ⇥ all projects · ⎋ cancel]       │
│                                                           │
╰───────────────────────────────────────────────────────────╯
```

omp 17.x to 18.1, unboxed: the same rows with no box, the title with one leading space, a rule under
it, the pointer in column 0, and the footer `  [Del/⌫ delete · Enter select · Tab all projects · Esc cancel]`
above a bare rule. A session may print **two** rows there instead of three: `omp--menu-resume.txt`
lists one titled session and two untitled ones, which show only the first prompt and the meta row.

Both footers print the commit key (`⏎ select`, `Enter select`) and the way out (`⎋ cancel`,
`Esc cancel`). That is why this is inside ADR 0009's rule, not an exception to it.

## What a tap sends

| Tap | Keys |
|---|---|
| the pointed session | `Enter` |
| a session below the pointer, `n` rows down | `Down` × n, then `Enter` |
| a session above the pointer, `n` rows up | `Up` × n, then `Enter` |
| the card's last row | `Escape` |

One batch per tap (`pane.send_keys` takes the array), so no half-walked pointer is ever left behind.
No digit anywhere, because the screen printed none. The arrow count is a claim about where the pointer
was, which is why the signature carries the `❯` column verbatim: a pointer moved at the desk between the
render and the tap refuses the tap (ADR 0055 point 6).

The walk is the shortest path and assumes the pointer does not wrap. A tap on a session that is on
screen never needs a wrap, so this holds for every row the card can offer.

## What the grammar requires, all of it

1. The layout's bottom border is the last non-blank row, one spacer row sits under the footer, and
   the footer is the row above that: boxed `│ [<hints>] │`, or bare `  [<hints>]`.
2. The footer is a hint list whose last segment is a way out (`⎋ cancel` and its five siblings) and
   which names `select`.
3. The layout's title, then its fixed header rows (blank, search row, blank; or blank, rule, blank,
   `>` row, blank), directly above the list.
4. The list: blank-separated groups, each ending in a meta row (an age or a date, then a size, then
   anything),
   three rows each, or two for an untitled session, in both layouts. Nothing else down to
   the footer.
5. Exactly one `❯`.
6. A signature no longer than the bridge accepts as a bound region (32768 characters, mirrored here
   as 32000).

Anything missing returns null and the screen stays raw, with the unread-dialog card over it.

## What is not modelled

`⌦/⌫ delete` and `⇥ all projects` act on the picker, not on a session. `PromptModel` has no field for
footer actions, so they stay off the card; the Keys drawer and the card's Terminal control reach them.
The search box is typed through Type mode. `⇥` toggles the title between `(current folder)` and
`(all projects)`, and the grammar reads either. The state with no session at all (`omp--v18-4-resume-nomatch.txt`)
has nothing to point at and is declined.

## Not proven by the captures

- **Probed live, 2026-10-02 (omp 18.4.10, Herdr, 109 by 59).** Taps on a two-session card, then on an
  eight-session card (five hand-made copies of one session log): seven of eight resumed exactly the
  tapped session in both walk directions, and one did nothing, which is the guard's safe side. The
  card's Cancel and the generic card's `Esc` closed their pickers. Not probed: the pointed row's own
  tap in a long list, a list longer than the pane, and a wider pane. The arrows and Enter go in one
  `send_keys` call and the guard compares the screen before it, not between the keys.
- A session list longer than the pane (a scroll counter, a `↓` marker) has no capture. The grammar
  declines on any unknown row, so such a list stays raw until it is captured.
- The all-projects title in the unboxed layout has no capture and is declined rather than guessed.
- A pane past about 550 columns at 59 rows makes the bound region longer than the bridge accepts (32768
  characters), so the picker declines there. The cap was 8192 until this slice raised it.

## Read from omp 18.4.10's source, not from a capture

These come from the session selector in the published `@oh-my-pi/pi-coding-agent` 18.4.10 bundle.
None is captured yet; re-capture before relying on them further.

- **The age.** `just now`, `N minute(s) ago`, `N hour(s) ago`, `1 day ago`, `N days ago` up to six
  days, then `toLocaleDateString()` in the process locale (`9/23/2026` in en-US). The grammar accepts a
  date of three numbers joined by `/`, `.` or `-`, so a project with week-old sessions still lifts.
  Other date shapes (`2026. 9. 23.` in ko) decline.
- **An untitled session** prints the first prompt on the pointer row and the meta row under it, two
  rows, in the boxed layout too. Captured: `omp--v18-4-resume-untitled-dated.txt`.
- **The pointer** is the symbol preset's `nav.cursor`: `❯` in `unicode` (the default), a Nerd Font
  glyph in `nerd`, `>` in `ascii`. Only `❯` is read; the other presets decline.
- **A pinned session** carries a pin glyph between the pointer and the title, so it shows in the
  card's label.
- **A list taller than the box** is drawn with an automatic scrollbar. Where its cells land is not
  captured. A scrollbar cell on a row the grammar needs blank declines the screen; one inside a
  session row would ride into that row's label or description.

# omp tool approval: keystroke recipe

The choreography notes file the Tier-2 bar asks for (`HARNESS_CONTRIBUTING.md`), for the third omp
screen the adapter lifts ([ADR 0078](../../../../../.adr/0078-the-omp-tool-approval-is-lifted-and-deny-never-lands-on-approve.md)).
Grammar: `approval.ts`. A wrong tap on this screen runs a shell command or writes a file, so every
claim below names its evidence.

Corpus: `omp--approval-bash.txt`, `omp--approval-write.txt`, `omp--approval-write--deny.txt` (omp
18.1.17, 2026-09-10, Nerd Font symbol preset) and `omp--v18-4-approval-*.txt` (omp 18.4.10,
2026-10-02, the default `unicode` preset: `bash` and `write` in both selection states, and a
fourteen-row `write`). Source, read in the published omp 18.4.10 packages: `tools/approval.ts`
(`formatApprovalPrompt`, `truncateForPrompt`), `extensibility/extensions/wrapper.ts` (the call),
`tools/bash.ts` and `tools/write.ts` (`formatApprovalDetails`), and pi-tui's
`overlays/hook-selector.ts` (the box, the keys).

This file replaces the assessment that stood here before the lift. Two of its statements were
source reads the 18.4.10 captures now settle: the `unicode` pointer is `❯`, and the 18.4.10 footer
prints glyph keycaps, `↑/↓ navigate  ⏎ select  ⎋ cancel`.

## What the screen prints

omp 18.4.10, a `write` call (`omp--v18-4-approval-write.txt`, 108 columns):

```
╭─ Allow tool: write ──────────────────────────────╮
│                                                  │
│ Path: /tmp/omp-sandbox-approval/note.txt         │   the body: what is approved
│ Content:                                         │
│ hello approval                                   │
│                                                  │
│  ❯ Approve                                       │   the pointed row
│    Deny                                          │
│                                                  │
│ ↑/↓ navigate  ⏎ select  ⎋ cancel                 │   segments split by two spaces
│                                                  │
╰──────────────────────────────────────────────────╯
```

The title is `formatApprovalPrompt`'s first line, `Allow tool: <tool name>`. Each later line of the
prompt is one body row, word-wrapped to the box: an optional `Reason: …` (a config pattern asked for
the approval), then the tool's details. `bash` prints `Command: <command>`. `write` prints
`Path: <path>`, a row reading `Content:` and the content. The box grows with the body
(`omp--v18-4-approval-write-long.txt`, fourteen content rows). omp shortens each field past 2000
characters itself and marks the cut `[…Nch elided…]`.

The two captured presets:

| Preset | Pointer | Footer | Captures |
|---|---|---|---|
| `unicode` (omp 18.4.10, the default) | `❯` | `↑/↓ navigate  ⏎ select  ⎋ cancel` | `omp--v18-4-approval-*.txt` |
| `nerd` (omp 18.1.17) | U+F054 | `up/down navigate  enter select  esc cancel` | `omp--approval-*.txt` |

The 18.1.17 captures also carry a one-row usage strip under the bottom border, from the operator's
statusline. The 18.4.10 captures carry none.

## Read the glyph, never the colour

The pointed row carries the preset's `nav.cursor` and one space before its label; the other row
carries three spaces. Both labels start at the same column. The pointed row also carries a theme
band, and the two capture sets show why the band is never read:

| Capture | Pointed row | Other row |
|---|---|---|
| `omp--approval-bash.txt` (18.1.17) | `│  U+F054 Approve`, bg `rgb(60,56,54)`, fg `rgb(254,128,25)` | `│    Deny`, no style |
| `omp--v18-4-approval-bash.txt` (18.4.10) | `│  ❯ Approve`, bg `rgb(0,130,179)`, fg `rgb(0,180,255)` | `│    Deny`, no style |

The band is the theme's `selectedBg`, painted by `paintSelectedRow` in `hook-selector.ts`, and the
label takes its `accent`. They differ between the two themes above, and a light theme, a 256- or
16-colour terminal or `NO_COLOR` moves them again. The glyph moves with the selection and with
nothing else: it is on `Approve` in four captures, on `Deny` in the other four, and on no other row.

## What a tap sends

| Tap | Pointer on Approve | Pointer on Deny |
|---|---|---|
| Approve | `Enter` | `Up`, `Enter` |
| Deny | `Down`, `Enter` | `Down`, `Enter` |
| the card's last row, `Cancel` | `Escape` | `Escape` |

One batch per tap. No digit anywhere: the screen printed none. The footer prints the arrows and
Enter, so every key is one the screen named.

What each key does, from omp 18.4.10's `HookSelectorComponent.handleInput`:

- `Up` and `Down` move the pointer through `MenuSelection.move(delta, false)`, which clamps at both
  ends and never wraps. So `Down` on `Deny` leaves the pointer on `Deny`. That is why the Deny button
  always sends `Down` first: whatever row the pointer is on when the keys land, the tap ends on
  `Deny`. Every race between the guard's read and the keys therefore resolves toward a denial.
- `Enter` calls the select callback with the pointed label. The wrapper approves only on the exact
  string `Approve` and throws `Tool call denied by user: <tool>` on anything else.
- `Escape` cancels. `select` resolves to `undefined`, which the wrapper treats as a denial.
- A digit jumps only to a label that starts with `N. `, and neither label does. Typing searches only
  when the list overflows its row budget, which two rows never do.

## What the card shows

- **Caption:** the title, `Allow tool: bash`, so the tool is named.
- **Approve's description:** every body row, joined by ` ↵ `. A row break is shown, never hidden, so
  `echo hi` and `rm -rf ~/x` on two rows can never read as one harmless `echo`. A soft wrap shows as a
  break too, which overstates and is the safe direction.
- **The accessible name** (`question`): the title and the same rows, one per line.
- **The raw mirror above the card:** the box's title and body, verbatim. The card starts at the
  `Approve` row, as Claude's and Codex's permission cards start at their first option.

There is no elision. Every row of a `bash` body, a `Reason:` row, a wrapped `Path:` and a `write`
body's content is on the Approve button. A write with more than thirty content rows declines, and so
does a field omp itself shortened (it marks any field past 2000 characters), so the card never shows
less than the dialog does. A first draft cut the content to six rows and `… +N`; it was dropped
because the signature would bind rows nobody read and a content row `… +4` would forge the marker.

## What the grammar requires, all of it

1. The bottom border is the last non-blank row. Under the 18.1.17 preset alone it may instead be the
   row above exactly one non-frame row (the usage strip, not part of the signature because it
   ticks). Under 18.4.10 any row under the border declines: it could be a shell prompt under a box an
   exited omp left behind, and `Up`, `Enter` would run the last command.
2. Above the border: a blank box row, the footer, a blank box row, exactly two option rows, a blank
   box row.
3. The footer is exactly one preset's text from the table above, character for character.
4. The option rows read `Approve` then `Deny`, and exactly one carries that same preset's pointer.
5. Above the options, a body of rows that open with the box's left side, its first row not blank, a
   blank box row, and the title `Allow tool: <name>` with nothing after the name.
6. The tool is `bash` or `write`, the two whose body is captured, and the body has the captured
   shape: an optional `Reason:` row, then `Command:` (bash) or `Path:` and a later `Content:` row
   (write).
7. No `[…Nch elided…]` mark anywhere in the body, even split across a wrap, no
   `Provider safety checks:` row, no control, zero-width or bidi character, no row that ends in `…`
   without a right border (a clipped row), and at most thirty content rows.
8. A signature no longer than the bridge accepts as a bound region (32000 characters here).

Anything missing returns null, and the screen stays raw with the unread-dialog card's Escape over it,
which omp also reads as a denial.

## Declined on purpose

- **A third option row.** omp's config-write approval prints `Always for this session`, `Allow
  once`, `Deny`, starts its pointer on the second row and runs a ten-second countdown
  (`#promptCfgChange` in `interactive-mode.ts`). Its title is not `Allow tool:` either. Never
  captured.
- **A countdown.** `HookSelectorComponent` appends `(Ns)` to the title while a timeout runs, and on
  expiry it selects the pointed row, which is `Approve` by default. The tool wrapper passes no
  timeout in 18.4.10. A title with a countdown declines, so the card never races a clock.
- **Another tool.** `edit` (`File:`), `eval` (`Language:`, `Code:`), MCP tools (`Origin:`), `task`,
  `lsp` and the rest print other bodies. Each needs its own capture.
- **The `ascii` preset** (pointer `>`), the `nerd` preset in 18.4 (private-use keycaps in the footer,
  as the Ask captures of 18.4.4 show), and `❯` over the text keycaps. None is captured.
- **A shortened field or a safety-check section**, for the reasons above.

## Not proven by the captures

- **Probed live, 2026-10-02 (omp 18.4.10, Herdr, `tools.approvalMode: always-ask`, paired headless
  browser).** Approve with the pointer on `Approve` ran `echo hello-approval-one`. Deny with the
  pointer on `Deny` (Down clamps) and Deny with the pointer on `Approve` each denied, and the file
  stayed absent. Approve with the pointer moved to `Deny` at the desk wrote the file (`Up`, `Enter`).
  A ten-line write showed six content rows and `… +4` on the card (the cut was dropped afterwards, so
  the card now shows all rows). Cancel denied, and the file stayed absent. A desk move followed at once by a Deny tap
  ended in a denial, which proves nothing about the guard. The guard was proven separately the same day
  through the bridge: with the dialog up and the pointer on `Approve`, `POST /api/pane/<id>/keys` with
  `Enter` and the signature of the same box with the pointer on `Deny` answered 409 `prompt_changed`
  and sent nothing (the dialog stayed up, the file stayed absent); the same call with the current
  signature and `Down`, `Enter` answered 200 and denied. Not probed: `Down` on `Deny` and `Up` on
  `Approve` read back on screen (the clamp is read from source, and the Deny-on-Deny tap above shows
  it), the 18.1.17 `nerd` preset, and a tool other than `bash` and `write`.
- **A body taller than the pane.** omp gives an overlay at most part of the terminal. Whether a very
  tall body scrolls, clips its top (then the title is gone and the grammar declines) or clips its
  middle is not captured. A middle clip would hide rows from the terminal too.
- **A process that exits under the dialog.** If omp exits with the box still painted and a shell
  prompt prints under it, the strip rule could read the prompt as the usage strip. Herdr stops
  reporting the agent about half a second after it exits (ADR 0053's addendum), after which no omp
  grammar runs.

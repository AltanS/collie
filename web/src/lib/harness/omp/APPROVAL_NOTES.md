# omp tool approval: assessment, not a recipe

This file assesses whether omp's tool-approval dialog can be lifted safely. Nothing here is
implemented. The dialog stays raw, with the unread-dialog card's `Escape` over it
([ADR 0076](../../../../../.adr/0076-the-omp-resume-picker-is-lifted-and-every-omp-modal-has-a-way-out.md)).
A wrong tap on this screen approves a shell command, so every claim below names its evidence.

Corpus: `omp--approval-bash.txt`, `omp--approval-write.txt`, `omp--approval-write--deny.txt`
(omp 18.1.17, 2026-09-10, Nerd Font symbol preset). Source: `tools/approval.ts`,
`extensibility/extensions/wrapper.ts` and pi-tui's `overlays/hook-selector.ts`, read in the omp
18.4.10 packages, which is newer than the captures.

## What the screen prints

```
╭─ Allow tool: write ─────────────────────────────╮
│                                                 │
│ Path: /tmp/collie-omp-sandbox/scratch.txt       │   the body: Reason, Command, Path, Content …
│ Content:                                        │
│ hello                                           │
│                                                 │
│  U+F054 Approve                                 │   the pointed row
│    Deny                                         │
│                                                 │
│ up/down navigate  enter select  esc cancel      │   segments split by two spaces
│                                                 │
╰─────────────────────────────────────────────────╯
 A 0h 0% w 00% …                                    the usage strip under the box
```

## Is the selected row readable? Yes, by a glyph, not only by colour

The brief for this file said the rows carry no pointer glyph. **The captures say otherwise.** Read
through the real `parseAnsi` → `splitLines` pipeline, the pointed row starts with U+F054
(nf-fa-chevron_right), the Nerd Font preset's `nav.cursor`, the same pointer the Ask dialog prints in
that preset (`omp--select-menu-other.txt`). It is a private-use glyph, so it is invisible in most
editors and terminals without a Nerd Font, which is likely why it looked absent.

| Capture | Row `Approve` | Row `Deny` |
|---|---|---|
| `omp--approval-bash.txt` | `│  U+F054 Approve`, bg `rgb(60,56,54)`, label fg `rgb(254,128,25)` | `│    Deny`, no style |
| `omp--approval-write.txt` | the same | the same |
| `omp--approval-write--deny.txt` | `│    Approve`, no style | `│  U+F054 Deny`, bg `rgb(60,56,54)`, label fg `rgb(254,128,25)` |

Three facts follow, consistent across all three captures:

1. **The glyph moves with the selection.** It sits on `Approve` in two captures and on `Deny` in the
   third, and on no other row.
2. **A background band moves with it.** The pointed row carries `bg rgb(60,56,54)` across its whole
   width: the theme's `selectedBg`, painted by `paintSelectedRow` in `hook-selector.ts`. The label
   takes the theme's `accent` foreground.
3. **The text alone tells the rows apart.** Pointed: a pointer glyph and one space before the label.
   Not pointed: two spaces. Both rows begin at the same column.

**Read the glyph, never the colour.** The band and the accent are theme colours. Another theme, a
light theme, or a terminal in 256 or 16 colours changes both values, and `NO_COLOR` may drop them.
The glyph is the preset's `nav.cursor`, which this adapter already reads per preset in `ask.ts`:
`❯` in `unicode`, U+F054 in `nerd`, and an uncaptured glyph in `ascii`. A grammar could use the band
only as a second check that must agree with the glyph, and it must decline when they disagree.

## What a safe grammar would need

1. **Every row's role from the screen.** The options are whatever omp passes to `ui.select`. Today
   the tool wrapper passes exactly `Approve`, `Deny`. Config writes pass `Always for this session`,
   `Allow once`, `Deny`, in that order (`interactive-mode.ts`), so there the default row grants a
   standing permission. A grammar must list the label sets it knows and decline any other.
2. **The pointer in exactly one row, in the preset that the footer's keycaps also name.** The text
   footer above is from 18.1.17. The 18.4.10 hook selector builds it from `formatKeyHint`, so it may
   print glyph keycaps now. That is uncaptured.
3. **The default is Approve.** The pointer starts on the first row (`initialIndex ?? 0` in
   `hook-selector.ts`; the `bash` and `write` captures show it there), so a bare `Enter`
   approves. ADR
   0055 already requires the card to show which row a bare commit key takes. On this screen the card
   should also never offer a bare `Enter`. Each button should carry its own walk, and the race guard
   must bind the pointer column.
4. **`Escape` means deny.** `select` resolves to `undefined` on cancel, the wrapper reads anything but
   `Approve` as a denial, and the call fails with `Tool call denied by user`. The card's Escape is
   therefore safe today, and a lift keeps it.
5. **The subject in the signature.** Two approvals for the same tool differ only in their body, the
   command or the path. The signature must carry the whole box verbatim, title through bottom
   border, as `ask.ts` and `resume.ts` do. The usage strip under the box ticks and must stay out.
6. **A long body.** A long command wraps, and `Content:` can run for many rows. The region may then
   pass the bridge's 32768-character bound, so the grammar must decline there, as the other two do.
7. **A timeout.** Config-write approvals wait 10 seconds (`CFG_APPROVAL_TIMEOUT_MS`), then fail as
   unanswered. A tap that arrives late meets a different screen, and the guard refuses it. That is
   safe, but the card should not suggest more time than exists.

## What to capture next

All on omp 18.4.10, in a sandbox pane, nothing approved that matters:

1. A `bash` approval in the default `unicode` preset, pointer on `Approve`, then the same screen after
   one `Down`. This shows the 18.4 pointer and the 18.4 footer keycaps.
2. The same pair in the `nerd` preset, to confirm the 18.1.17 shape still holds.
3. A `write` approval whose `Content:` runs past the box height, to show how a long body scrolls or
   clips.
4. A config-write approval with three rows (`Always for this session`, `Allow once`, `Deny`).
5. One capture under a light theme, to document that the band colour moves while the glyph does not.

Use `--approval-mode always-ask` or a config `approval: prompt` pattern, as the 18.1.17 captures did.
Live-probe `Down`, `Up`, `Enter` on `Deny` and `Escape` on that screen before a recipe is written.

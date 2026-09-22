# 0058 — The resume picker commits with Enter

- **Status:** Accepted
- **Date:** 2026-09-22
- **Shipped in:** pending (target 1.12.0)
- **Trail:** `web/src/lib/harness/claude/resume.ts` (`detectResumePickerRegion`) ·
  `web/src/lib/harness/claude/index.ts` · `web/src/lib/harness/claude/prompt-select.ts`
  (`pointerWalk`) · `web/src/fixtures/panes/claude--menu-resume-picker--*.txt` ·
  [ADR 0009](./0009-a-generic-menu-is-driven-by-the-keys-it-names.md) ·
  [ADR 0055](./0055-a-pointed-list-is-walked-then-confirmed.md) ·
  [ADR 0056](./0056-a-card-can-be-put-down.md)

## Context

**`/resume` could not resume anything from Collie.** Claude Code 2.1.278 paints the session picker
like this:

```
   Resume session
   ╭──────────────────────╮
   │ ⌕ Search…            │
   ╰──────────────────────╯
     resume-lab

   ❯ say ok
     2 minutes ago · master · 176.8KB

     Ctrl+A to show all projects · Ctrl+B to only show current branch · Space to preview ·
     Ctrl+R to rename · Type to search · Esc to cancel
```

The footer never prints Enter, and it never prints the arrows. The screen had no specific grammar, so
the generic menu took it, and ADR 0009 lets a generic menu send only the keys the screen names. The
card therefore offered Up, Down and Cancel, and no tap could commit a resume. At 120 columns the
footer also wraps onto two rows and the generic grammar reads one, so Rename was lost too.

Every row on this screen is a session: a title row, then a meta row (`<age> ago · <branch> ·
<size>`). The `❯` pointer marks the row Enter takes, as it does in every Claude list, and ADR 0055
already turns a pointed list into a walk plus a commit key. What this screen lacks is the commit key
in its own footer.

## Decision

**A dedicated grammar recognises the picker by its own title, its own search box and its own
footer, and lifts it as a `prompt-select` list of sessions. A tap is the pointer walk to that row,
then `Enter`, sent as one batch.**

1. **The evidence, all required.** A row that reads `Resume session` or `Resume session (N of M)`.
   Directly under it, a rounded search box: `╭`, a `│` row carrying `⌕`, `╰`, all at one column. A
   key-hint footer at the tail, read across its wrapped rows (`readKeyHintFooter`), that names `Esc
   to cancel` or `Esc to clear`. No input box at the tail. Anything missing returns null, and the
   generic menu still runs.
2. **The rows.** A session is a title row followed by a meta row at the title's own column. Every
   other row between the box and the footer, such as the project heading and blank rows, is
   skipped. The label is the title and the description is the meta text.
3. **The pointer.** The title row with `❯` in the box's column is the pointed row. A `↓` or `↑` in
   that column is a scroll marker: the row is a session, not the pointed one. Two pointers decline
   the screen.
4. **The keys** are ADR 0055's: option *i* sends `Down` × (*i* − pointed) or `Up` × (pointed − *i*),
   then `Enter`. The pointed row sends `["Enter"]` and its badge shows `❯`. No digit anywhere. With
   no pointer, a single listed session (the typed-search state, whose footer does name `Enter to
   select`) sends `["Enter"]`. Several sessions and no pointer decline the screen.
5. **The way out** is the footer's own Esc segment, in its own words (`Cancel`, or `Clear` while a
   search is typed), as the last row of the card. `PromptModel` has no field for footer actions, so
   `Ctrl+A` and `Ctrl+B` are not added; no new field is created for them.
6. **The race guard** is ADR 0055 point 6 unchanged. The signature runs from the title through the
   footer and carries the pointer column verbatim, so a pointer that moved between the render and the
   tap refuses the tap.

**This is a narrow exception to ADR 0009.** Enter is sent unprinted on this one dialog, because the
`❯` pointer means "Enter takes this row" in every Claude list, and because the dialog is identified
by its own words, not by the key. No other dialog gains an unprinted key from this ADR. A second
dialog that needs one needs its own ADR.

## Consequences

- **A session resumes from the card.** The generic menu no longer claims the picker; it still
  catches the screen whenever this grammar declines it.
- **Rename and preview stay off the card.** `Ctrl+R` and `Space` open sub-states the card does not
  model. The Keys drawer and the Terminal control (ADR 0056) remain the way to reach them, and to
  reach `Ctrl+A` and `Ctrl+B`.
- **The search box is typed through Type mode.** The card does not type into it.
- **The meta row ages.** `1 minute ago` becomes `2 minutes ago` while the card is up, which moves
  the signature. A tap across that tick is refused and the card re-renders. That is the safe side
  of the trade.
- **Revisit** when Claude prints Enter in this footer (the exception then becomes ADR 0009's normal
  case), or when a second dialog asks for an unprinted key.

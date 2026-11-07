# Codex hook-trust prompt — keystroke recipe

Captured 2026-11-07 on Codex 0.166.0 and 0.167.0 (the same copy on both), in a lab `CODEX_HOME` whose
`hooks.json` held the SessionStart hook Herdr's Codex integration installs. Codex shows it at launch,
before the composer, when a hook is new or changed, and again at EVERY launch until the hook is trusted:
`Continue without trusting` and `esc skip` decide nothing for next time.

```
  Hooks need review
  1 hook is new or changed.
  Hooks can run outside the sandbox after you trust them.

› 1. Review hooks
  2. Trust all and continue
  3. Continue without trusting (hooks won't run)

  enter confirm · esc skip
```

Fixtures: `codex--v0167-hooks-review--w120.txt`, `codex--v0167-hooks-review--w80.txt`, and
`codex--v0167-hooks-review-moved--w80.txt` (the pointer on row 2, the walk pair).

Probed live on 0.167.0, 2026-11-07:

| Keys | Effect |
|---|---|
| `Down, Enter` | Trusted the hook and opened the composer. The next launch asked nothing. |
| `Down, Down, Enter` | Opened the composer with the hook untrusted. The next launch asked again. |
| `Escape` | The same as `Continue without trusting`. |
| `Down` | Moved the pointer to row 2 (the moved capture). |

No digit was pressed. `Enter` on `Review hooks` was not pressed either; `/hooks` opens the same kind of
browser (`enter details · esc close`), which no grammar reads.

What the adapter emits (`hooks.ts`): one button per row, each the arrow walk from the `›` pointer plus
Enter, with the two warning rows as the card's subject. The title, the three labels in order, one
pointer and the footer are all pinned; a row that wraps on a narrow pane refuses, and the screen then
gets the unread-dialog card, whose Escape is `esc skip`.

One trap seen in the lab, not a reader matter: a 0.167.0 TUI started against a `CODEX_HOME` whose
background daemon was still 0.166.0 printed `Error: config/read failed in TUI` on `Escape` here and
exited.

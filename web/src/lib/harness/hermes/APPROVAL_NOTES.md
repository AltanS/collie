# Hermes dangerous-command approval — keystroke recipe

Captured 2026-10-16 on Hermes Agent v0.22.2 (`hermes --cli`) in a sandbox Herdr pane (Herdr 0.9.1),
120 and 60 columns, `approvals.mode: manual` in a scratch Hermes home, against the same
zero-inference endpoint as CLARIFY_NOTES.md (a scripted `terminal` call to `rm -rf` on a scratch
path). Read against `_get_approval_display_fragments`, `_tui_make_approval_number_handler` and
`_APPROVAL_CHOICE_KEYS` in `hermes_cli/cli_tui_mixin.py`.

The panel sits above the input; the prompt reads `⚠ ❯` (`⚠` below 64 columns).

```
╭────────────────────────────────────────────────╮
│ ⚠️  Dangerous Command                          │
│                                                │
│ rm -rf /tmp/collie-hermes-lab/scratch-dir      │
│                                                │
│ ❯ 1. Allow once                                │
│   2. Allow for this session                    │
│   3. Add to permanent allowlist                │
│   4. Deny                                      │
│                                                │
│ delete in root path                            │
╰────────────────────────────────────────────────╯

  💻 rm -rf /tmp/collie-hermes-lab/scratch-dir  (  5.0s · ↓ 40 tok)
  ↑/↓ to select, Enter to confirm  (295s)
```

A command over 70 characters adds `5. Show full command`. Hermes cuts a command that wraps past
four rows to three and adds `… (choose Show full command)`; one that does not fit the terminal at
all ends in `… (command truncated — use /logs or /debug for full text)`. The choices shrink to
`Allow once` and `Deny` when Hermes's smart approval denied the session option. The countdown is
`approvals.timeout`, 300 s by default, after which Hermes denies.

Live-probed:

| Key | Effect |
|---|---|
| `Down` | Moves `❯` to the next choice. Confirms nothing. |
| `4` | Confirms **Deny** at once: `You denied this command — it did not run.` |
| `5` | **Show full command**: the panel redraws with the command whole, row 5 gone and `❯` on Deny. Confirms nothing. |
| `Ctrl+C` | Denies (`⚠ Approval: … → denied`) and ends the turn. Hermes keeps running. |

Not probed at the terminal: `1` (Allow once); it is the live end-to-end check from the phone (see
the PR). `2` and `3` are never sent: they change Hermes's standing policy for the session or for
good.

What the adapter emits (`approval.ts`), a `prompt-select` of family `permission` (the digit alone
confirms), classified by label:

- **Allow once** and **Deny** are buttons. **Show full command** is a button when the panel has it;
  it only redraws.
- **Allow for this session** and **Add to permanent allowlist** are never buttons. Any other label
  refuses the whole panel.
- While the command shows `… (choose Show full command)`, there is no Allow once button: the card
  offers Show full command and Deny until the command is on screen whole. The notice is matched on
  its first row, `… (choose `: a panel narrower than it (inner width 24 to 27, a pane of about 30
  columns) wraps it onto two rows, and Hermes's smart-deny set (once, deny, view) fits that panel.
  A command cut with `… (command truncated …)` cannot be shown whole, and the panel stays raw.
- The card's subject is the command and Hermes's reason, so the phone shows what is being approved.

The bound region is the panel alone, with `bindTail` for the ticking rows under it, as for clarify.

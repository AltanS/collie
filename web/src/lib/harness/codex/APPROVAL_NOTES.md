# Codex exec-approval — keystroke recipe

Captured 2026-08-22 on Codex v0.149.0 in a sandbox pane started with
`--ask-for-approval on-request -c approvals_reviewer=user`. Note the config dependency: with
`approvals_reviewer = "auto_review"` (this host's default) eligible approval requests are routed
through a reviewer subagent instead of the user — the observed commands were approved with no
dialog painted. `user` restores the human dialog. The card REPLACES the composer (no `› `
prompt / status row at the tail). Herdr status: `blocked`.

```
  Would you like to run the following command?
  Environment: local
  Reason: Do you want to allow creating /tmp/collie-codex-probe.txt outside the sandbox?
  $ touch /tmp/collie-codex-probe.txt
› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with `touch /tmp/collie-codex-probe.txt` (p)
  3. No, and tell Codex what to do differently (esc)
  Press enter to confirm or esc to cancel
```

Live-probed, in this session:

| Key | Effect |
|---|---|
| `y` | Confirms **Yes, proceed** immediately (file created). |
| `1` | Same — digits confirm their row directly, no Enter (file created on a second card). |
| `3` | Confirms **No** immediately; the command never ran (file verified absent ON DISK — negative control) and the conversation shows "interrupted — tell the model what to do differently". Rendering quirk: Codex still paints a `• Ran <cmd>` transcript row for the CANCELLED tool call — that row is the attempted call's entry, not execution evidence; the on-disk check is what proved non-execution. |
| `Enter` | Confirms the **highlighted** row (default highlight was row 1). |

Not probed (so not emitted): row 2 / `p` (persists an approval prefix — a mode change), bare
`esc` (row 3's shortcut; digit 3 is the probed reject).

What the adapter emits — the one-shot Yes and the reject only, and only when every row proves
its class: the FIRST row must be `Yes, proceed`, the LAST row must be `No, and tell Codex what
to do differently`, and every row between must match `don't ask again` (persistent — never a
button). Any other row shape refuses the whole card. Digits are consecutive `1..n`; the footer
and the `Would you like to run the following command?` header must both be on screen. The
header, Reason, `$ command`, and persistent "don't ask again" rows stay in the raw mirror
above the buttons, so the operator reads exactly what they are approving and still sees the
persist option even though it is never a button.

Other approval kinds (MCP consents, …) have different headers and fail closed until captured.

## Codex 0.156.1 (captured 2026-09-26, keys probed the same day)

The captures were read-only. The keys were probed afterwards, in a fresh sandbox pane. Three changes:

**A two-row exec card.** A heredoc command came with only `1. Yes, proceed (y)` and
`2. No, and tell Codex what to do differently (esc)`, no persistent row
(`codex--v0156-approval-exec-2opt.txt`). The classification already allows zero middle rows, so
the grammar now accepts `n >= 2`. The reject still sends its own digit, `2` here. That is the
exec rule probed on 0.149.0 (a digit confirms its row), applied to a card with one row fewer. It
is not a new probe.

**Wrapped labels.** A label longer than the pane wraps onto rows indented to the label column
(five cells, under `  N. `). At 50 columns this hits an ordinary `touch` command, and the reject
row wraps its `(esc)` onto a row of its own (`codex--v0156-approval-exec-wrapped-50.txt`). The
grammar rejoins those rows into the label before it classifies it. A row at the label column with
no option under it refuses the card.

**The patch approval.** `Would you like to make the following edits?`, with `Description:` and
`Destination:` rows, then the same option recipe: `1. Yes, proceed (y)`,
`2. Yes, and don't ask again for these files (a)`, `3. No, and tell Codex what to do differently
(esc)`, and the same footer (`codex--v0156-approval-patch.txt`). The classification is the same,
so the persistent `(a)` row is never a button.

The keys differ, on purpose. The digit recipe was never probed on a patch card, so it is not
carried over. The patch buttons send the shortcuts the rows print: `y` for Yes, and `Escape` for
the reject. `y` is the key probed on the exec card's Yes row. `Escape` is what both the reject row
and the footer print, and it is the key the unread-dialog card already sent on this screen before
the grammar read it. A patch row that prints any other shortcut refuses the card.

Probed live on 2026-09-26: `y` on a patch card created the file, `Escape` on a second one
declined it (no file, "Failed to apply patch"), and `2` on a two-row exec card declined the
heredoc (no file written).

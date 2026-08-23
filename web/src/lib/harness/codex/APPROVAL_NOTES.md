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
header, Reason, and `$ command` rows stay in the raw mirror above the buttons, so the operator
reads exactly what they are approving.

Only the exec-command approval is captured; other approval kinds (patch application, MCP
consents, …) have different headers and fail closed until captured and probed.

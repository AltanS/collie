# 0078: The omp tool approval is lifted, and Deny never lands on Approve

- **Status:** Accepted
- **Date:** 2026-10-02
- **Shipped in:** 1.16.0
- **Amends:** [ADR 0076](./0076-the-omp-resume-picker-is-lifted-and-every-omp-modal-has-a-way-out.md)
  and [ADR 0077](./0077-the-omp-ask-single-select-is-lifted-and-its-multi-select-is-not.md), in
  scope. Both left the tool-approval dialog raw with the Escape card; the `bash` and `write`
  approvals in the two captured presets are now a card. Everything else in both stands.
- **Trail:** the road this closes is the one 0076 and 0077 kept open on purpose, the approval
  dialog as raw text plus one Escape button, which can only refuse; `omp/APPROVAL_NOTES.md` was the
  assessment that held it there until a capture set existed ·
  `web/src/lib/harness/omp/approval.ts` (`detectApprovalRegion`) ·
  `web/src/lib/harness/omp/APPROVAL_NOTES.md` · `web/src/lib/harness/omp/index.ts` ·
  `web/src/fixtures/panes/omp--v18-4-approval-*.txt`, `omp--approval-*.txt` · pi-tui
  `overlays/hook-selector.ts` and the coding agent's `tools/approval.ts` (omp 18.4.10) ·
  [ADR 0009](./0009-a-generic-menu-is-driven-by-the-keys-it-names.md) ·
  [ADR 0055](./0055-a-pointed-list-is-walked-then-confirmed.md) ·
  [ADR 0058](./0058-the-resume-picker-commits-with-enter.md)

> **Amended 2026-10-02 by [ADR 0080](./0080-a-pointed-list-is-walked-verified-then-confirmed.md):**
> Deny is no longer a fixed `Down`, `Enter` plan. The model's plan is the plain walk,
> `pointerWalk(pointedAt, 1)`: `Enter` when the pointer is on Deny, `Down`, `Enter` when it is on
> Approve. Approve is unchanged (`Enter`, or `Up`, `Enter`). The action layer sends the arrows, reads
> the pointer back, and sends the commit only bound to a fresh read that shows the pointer on the
> tapped row; a pointer that moved sends nothing. The clamp is a fact about omp's list that the
> model now declares as `clampedEnds`, and the action layer consumes it (ADR 0080 point 6): the
> commit batch is `Up`, `Enter` for Approve and `Down`, `Enter` for Deny, so the guarantee in the
> title, that a race never turns a Deny tap into an approval, is restored, now for Approve as well,
> as a declared fact and a generic commit rule and not as a plan shape. The body below is the
> decision as first written; point 2 and the two Consequences bullets that argue from the clamp
> ("one keystroke more", "the tap batch is one request") are superseded by that rule: the verify
> step adds one read and the walk is a separate call. The only window left is for a row that is not
> an edge, which this two-row card does not have.

## Context

**omp's tool approval blocks the agent until a human decides.** Under `--approval-mode always-ask`
or a config `approval: prompt` pattern, every `bash` or `write` call waits on this box. Since ADR
0076 the phone showed it as raw terminal text with one Escape button, so an operator away from the
desk could deny and never approve.

The 2026-10-02 captures (omp 18.4.10, `unicode` preset) and the 2026-09-10 ones (omp 18.1.17,
`nerd` preset) show one shape:

```
╭─ Allow tool: bash ───────────────────────────╮
│                                              │
│ Command: echo hello-approval                 │
│                                              │
│  ❯ Approve                                   │
│    Deny                                      │
│                                              │
│ ↑/↓ navigate  ⏎ select  ⎋ cancel             │
│                                              │
╰──────────────────────────────────────────────╯
```

The 18.1.17 footer reads `up/down navigate  enter select  esc cancel` and its pointer is U+F054.
The pointed row also carries a theme band whose colours differ between the two capture sets.

omp 18.4.10's source adds what no capture shows. The list clamps at both ends and never wraps. Enter
approves only on the exact label `Approve`; anything else, Escape included, is a denial. Each body
field past 2000 characters is cut and marked `[…Nch elided…]`. A config-write approval prints a third
row, `Always for this session`, under another title and with a countdown. And a selector given a
timeout picks the pointed row when it expires.

**This is the one omp screen where a wrong tap runs a command.** A card here has to answer three
questions the other two lifts did not: what the person sees before tapping, which way a race goes,
and what the grammar refuses to guess.

## Decision

**The `bash` and `write` approval becomes a pointed list of Approve, Deny and Cancel. Deny is a fixed
key sequence, the card carries the subject, and every uncaptured shape declines.**

1. **The buttons are in screen order: Approve, Deny, then Cancel.** The order matches the terminal,
   so the `❯` badge on the pointed row tells the person where a bare Enter at the desk would land,
   as ADR 0055 point 5 requires. Each button is one tap.
2. **Approve is ADR 0055's walk, and Deny is always `Down` then `Enter`.** Approve sends `Enter` when
   the pointer is on it and `Up`, `Enter` when the pointer is on Deny. Deny sends `Down`, `Enter`
   from either row, because Down clamps on the last row. So every race between the guard's read and
   the keys landing ends on Deny: a desk keystroke in that window can turn an Approve tap into a
   denial, never a Deny tap into an approval. The keys are all printed in the footer, so this is
   inside ADR 0009's rule. No digit.
3. **The card's last row is the footer's way out**, `Cancel`, sending `Escape`, as 0076 and 0077 do.
   omp reports it to the agent as a denial.
4. **The card carries the subject.** The caption is the title, `Allow tool: <tool>`. Approve's
   description is every body row joined by ` ↵ `, so a newline in a command is never read as a
   space. The accessible name is the title and the same rows. The card starts at the `Approve` row,
   as Claude's and Codex's permission cards do, so the box's title and body also stay in the raw
   mirror above it, verbatim.
5. **The card hides nothing, and declines rather than cut.** Every row of a command, a reason, a
   path and a write's content is on the Approve button. A write with more than thirty content rows
   declines; omp shortens each field to 2000 characters itself, so an ordinary file fits. A first
   draft cut the content to six rows and `… +N`. Counsel rejected it: the signature binds rows the
   person never read, a payload at the end of a file (a `.bashrc` or `authorized_keys` line) is the
   classic case, and a `… +N` row in the content would forge the marker. A body carrying omp's own
   `[…Nch elided…]` mark declines, and so does a body with a control, zero-width or bidi character
   (they let the card read differently from the command) or a row that ends in `…` with no right
   border (a clipped row, not a wrapped one). Rows are joined with ` ↵ `, which cannot tell a soft
   wrap from a newline and shows both as a break; a command that literally contains ` ↵ ` is shown
   the same way. That is a known imprecision, in the safe direction.
6. **The race guard is 0076's.** The signature is the region from the title through the bottom
   border, rows trimmed of trailing space and otherwise verbatim, so a moved pointer, another command
   or another file refuses the tap. The core signature blanks the pointer alone. A region over 32000
   characters declines, under the bridge's 32768 bound. The usage strip under an 18.1.17 box is not
   in the signature, because it ticks. Only that preset may have one: under an 18.4.10 box any row
   declines, because a box left on screen by an exited omp with a shell prompt under it would pass
   for the strip, and `Up` then `Enter` in a shell runs the last command.
7. **Two presets, each from its own captures, and no mix.** `❯` with `↑/↓ navigate  ⏎ select  ⎋
   cancel` (18.4.10) and U+F054 with `up/down navigate  enter select  esc cancel` (18.1.17). The footer
   must match one preset character for character, and the pointer must be that preset's. The
   chevron under glyph keycaps is a pair omp 18.4 does not print (its `nerd` preset prints private-use
   keycaps there), and `❯` over the text keycaps is uncaptured, so both decline. So does `ascii`.
8. **Everything uncaptured declines and keeps the Escape card.** A third option row, a pointer on
   neither or both rows, other labels, a countdown in the title, a search status row, a clipped
   footer, a tool other than `bash` or `write`, a body of another shape, and a `Provider safety
   checks:` section.

## Consequences

- **An omp `bash` or `write` approval is answered from the card**, in both captured presets. The
  agent continues as soon as the tap lands.
- **A Deny tap costs one keystroke more** when the pointer already sits on Deny. That keystroke is a
  no-op on the dialog, and it is what makes the race one-sided.
- **The badge column mixes kinds**, as 0055 foresaw: the pointed row shows `❯`, the other row
  shows nothing, and Cancel shows `Esc`.
- **Other tools keep the Escape card.** `edit`, `eval`, MCP tools and the rest print other bodies;
  each needs its own capture. So does omp's config-write approval.
- **The transcript above the box is a raw block again.** The splash above the 18.1.17 captures pans
  as a table again (`table-run.test.ts`).
- **Live verification, 2026-10-02 (omp 18.4.10).** Approve from both pointer rows, Deny from both
  pointer rows and Cancel behaved as designed against a real pane; no denied file was written. The
  six-row cut that the run also exercised was dropped afterwards (point 5), so the card now shows
  all of a ten-line write. The 18.1.17 captures lift from fixtures alone and were not probed live. The stale-tap refusal was proven through the bridge: a stale
  signature got 409 `prompt_changed` and no key was sent, and the current one got 200. APPROVAL_NOTES.md records the
  detail and what was not probed.
- **What the card cannot show.** It shows what omp's dialog prints. Any argument the dialog leaves
  out (a working directory, an environment, a timeout) is not on the card either.
- **Two identical calls in a row share one signature,** so a tap meant for the first can land on the
  second if it appears in the same place. The tap is still an approval of the same command.
- **The tap batch is one request.** If the dialog closes between the guard and the keys, a trailing
  `Enter` can land on whatever omp draws next. That window is milliseconds and cannot be closed from
  the phone; Deny's keys end on a clamped row, so only an Approve tap carries the risk.
- **Revisit** when omp passes a timeout to the tool approval, when a capture shows another tool's
  body, a third row, a body taller than the pane or another preset, or when omp changes what Enter
  or Escape mean on this dialog.

## Amendment, 2026-10-25: omp 18.12.6 draws a third row and a new footer, and its list wraps

omp 18.12.6 rebuilt the dialog on its overlay panel (`approval-dialog.ts`, lab capture
`omp--v18-12-6-approval-bash--w120.txt`). The title is the same. The body is one compact row,
`Command: …`, with no blank spacer rows. Under it come `Approve`, a new `Approve bash for this session`
(`Approve <tool> for this session`, when the call may be granted) and `Deny`, then a divider and the
footer `↑/↓ choose · ⏎ select · Ctrl+⏎/Ctrl+Q approve · ⎋ deny · Ctrl+O details · type to deny and steer`.
The composer's band stays drawn under the box and takes typing, where a typed character denies the call.
The first grammar required exactly `Approve` then `Deny` and the old footer, so on 18.12.6 the Surface
read `modal: unreadable`, the phone had no card, and every send was refused `unconfirmed`. This is
the case the "Revisit" line named: a third row and a changed footer.

`approval.ts` now reads a second shape beside the first; both stand. The points of 0078 that change in
the second shape:

- **The card carries the third option**, `Approve bash for this session`, in the screen's own words and
  its own position, a walk from the pointer like Approve. It grants every later call of that tool for
  the rest of the session, which is why it is a button of its own and never the default.
- **Deny is `Escape`, not a walk.** The panel's list wraps (`(choice + delta + count) % count`), so
  point 3's clamped last row is gone. `Down, Enter` from Deny would approve, and `Up, Enter` would
  approve for the session. `⎋ deny` is named by the footer and denies from any row, so a Deny tap can
  never approve whatever a desk arrow does between the read and the send. Point 3's guarantee holds by a
  different route. The model does not declare `clampedEnds`, since `Up, Enter` on the first row would
  deny. There is no separate Cancel button: it would be the same key.
- **An Approve or session tap commits with a bare `Enter` on a verified read** (ADR 0080). The window is
  the milliseconds between the bridge's read and its send; a desk arrow there can move an approval to
  the neighbouring row, never a denial to an approval.
- **The body is a summary, so the card declines a row that ends in `…`.** omp hands the dialog the
  compact prompt: each detail's first line, ` …` after it when there were more lines, every row clipped
  to the box. A cut row may hide part of the command, so only a whole `Command:` row lifts. `write` is
  declined on 18.12.6 (its row is always `Path: … · Content: <first row> …`, no capture holds one) and
  keeps the Escape card.
- **Fail closed as before:** one exact footer (the keycaps follow the install, so any other dialect
  declines), a pointer on exactly one row, a session row naming the title's tool, a title with no
  countdown, and under the border nothing but the composer's band and its empty prompt row. A draft in
  the composer relabels Deny `Deny and send message`, which declines. The `always-ask-cached` grant rows,
  a PgUp/PgDn scroll hint and the nerd preset decline. A lifted panel also takes the composer away from
  `locateComposer`, since the box under it is not an input while the panel is up.

The Deny-on-the-last-row and clamp facts of 0078 stay true for omp 18.1.17 to 18.6.1. Proven in the
lab by raw keys on 18.12.6: Enter approves, Escape denies, Down then Enter approves for the session.
Not probed live: the moved-pointer screens (derived in tests from the capture and the source), a
`Reason:` row, and the two-row list of a call that cannot be granted.


## Amendment, 2026-10-25: omp 18.6.1 asks for the `goal` tool, and its dialog has no body

The omp-gang tester (report 02) saw `Allow tool: goal` on omp 18.6.1 during a `/goal` turn: the title, two
blank rows, `Approve`, `Deny` and the first shape's footer, nothing else (`omp--v18-6-1-approval-goal--w120.txt`).
The tool has no `formatApprovalDetails` (`goals/tools/goal-tool.ts`), so `approvalDetails` returns no rows.
The grammar needed a body row and a `bash` or `write` title, so the Surface read `modal: unreadable`
and the phone had no card; a goal turn stopped there until someone pressed a key at the desk.

`approval.ts` now lifts `goal` as the first shape with an EMPTY body (`BODYLESS_TOOLS`). Everything else
of 0078 holds unchanged: the clamp at both ends, Approve and Deny as walks from the pointer, the commit
as `Up, Enter` or `Down, Enter` so Enter is never bare on an edge, Cancel as Escape, one exact footer, the
region verbatim as the signature. What is new:

- **The card names the tool and nothing else, because the screen shows nothing else.** The Approve button
  has no description. omp's own source says why the call asks: "Goal ops touch only session state; the
  rest change the goal, so `always-ask` still prompts". Which op the model called (`create`, `complete`,
  `resume`, `drop`) is in the transcript row above the box (`⏳ Goal: complete`), not in the dialog. This
  is the first lifted tap whose subject is not on the card; it is accepted because the tool cannot run a
  command or write a file.
- **A bodyless tool lifts only with exactly that body.** A `Reason:` row, any body row, a third option, a
  countdown, another footer or another tool name still declines. No other tool is bodyless.
- **The 18.12.6 divided panel for `goal` is not captured**, so it declines as before.

The conformance perturbation test cannot find a free-text row in this dialog; it lists the fixture as a
fixed region and checks the stronger fact that every one-row change stops the lift or moves the signature.

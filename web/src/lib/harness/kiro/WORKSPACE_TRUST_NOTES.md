# Kiro CLI V3 startup workspace trust

## Provenance

Captured on 2026-10-21 with `kiro-cli 2.33.0`, Herdr 0.9.5 and x86_64 Linux. The CLI ran as
`kiro-cli chat --v3` in an empty, newly created temporary folder, in an isolated Herdr session.
No chat message, trust flag or tool-approval shortcut was supplied.

The `kiro--v3-workspace-trust-*` fixtures are Herdr's visible ANSI grid, read with
`herdr pane read <pane> --source visible --format ansi --raw`. The attached terminal was resized
so the pane had 120, 60 or 40 columns and 60 rows. The same dialog stayed open while Up/Down
changed its pointer. Rows above its top divider were removed; the dialog's ANSI, wrapping and
line endings were kept. The user name, temporary folder suffix and workspace-root hash were
replaced with equal-length aliases, including the fragments of the hash on wrapped rows.
There are no credentials or conversation contents in these fixtures.

## Verified keys

The screen prints `esc to exit · ↑↓ to navigate · ↵ to select`, wrapped onto two rows at
40 columns. Its initial highlighted row is **Trust, continue**. Up/Down move one row and clamp
at both ends. The two edge captures show that an extra Up on Trust and an extra Down on
Don't trust leave the selection unchanged. Escape exits without accepting trust.

Both option rows are exposed, so the model declares `clampedEnds`. The generic action path
walks to the chosen row, reads it back, then commits with the sticky edge arrow and Enter.
The grammar never invents a digit shortcut.

## Live phone verification

A Playwright Pixel 7 browser opened the built app against a loopback-only scratch Collie bridge
and a separate Herdr session. The browser used a device paired through the normal pairing flow.
An anonymous snapshot read was refused with `403 device not paired` before the tests.
Every decision below was one native button tap through the real `POST /api/ask/<id>` route;
the receipt said `origin: person_tap` and `outcome: sent`.

| CLI width | Button | Keys recorded | Observed result |
| --- | --- | --- | --- |
| 120 | Don't trust, exit | Down, Down, Enter | CLI exited; workspace remained untrusted |
| 120 | Trust, continue | Up, Enter | Only the empty test folder was trusted; the normal composer became free |
| 60 | Don't trust, exit | Down, Down, Enter | CLI exited; workspace remained untrusted |
| 40 | Don't trust, exit | Down, Down, Enter | Wrapped dialog was answered; CLI exited; workspace remained untrusted |

The first Down walks from Trust to Don't trust. The second is the commit's sticky edge arrow.
Trust was already highlighted, so its commit was the sticky Up and Enter. No model prompt
was sent, and all scratch processes were stopped after verification.

Before/after screenshots, ANSI reads and the receipts are retained locally under
`.screenshot-bugs/kiro-workspace-trust/`. They are evidence, not screenshot baselines or
published fixtures. `continue-w120-before.png` shows the native card with its full subject;
`continue-w120-after.png` shows the normal composer after the explicit Trust tap.

## Recognition and binding

This startup screen differs from a tool approval: its dividers start at column 1, the title has
its own pair of dividers, the footer says `esc to exit`, and a revocation note follows it.
The tool-panel grammar and composer pre-flight remain unchanged.

The dedicated detector requires the exact title, complete Unix workspace path, both complete
warnings, the exact two option rows with one pointer, the printed footer and the complete
revocation note at the tail. It accounts for word-wrapped prose and mid-word path wraps.
Unknown rows, quoted or dismissed screens, clipped paths/warnings/notes, hidden controls,
ellipses and oversized regions decline to the raw terminal.

The card displays the path and both warnings. Its signature binds the whole dialog, including
the revocation note. Walk identity removes only the parsed option pointer; a pointer glyph in
a path is kept. Changing a path, warning, option or note invalidates the decision. The normal
composer remains unavailable until Kiro paints it; the detector sends no text or automatic
trust decision and does not widen the send profile's verified version range.

## Regression coverage

`workspace-trust.test.ts` exercises the real captures, pointer identity, edge commits,
complete subjects, bridge binding and conservative refusal. `kiro.test.ts` includes these
screens in adapter conformance, `walk-pairs.ts` declares the selected-row pairs, and the
Surface labels and binding-region corpus pin every added capture.


## Startup readiness and pending messages (2026-10-22)

A launch's successful response means the shell command was typed, not that the agent's first
screen is ready. Known-agent launches now carry a scoped, frontend-only intent. The phone keeps
an editable local draft and waits for a real initial dialog or composer; it does not offer an
ordinary Send against the temporary shell or an unread startup frame. Trust is rendered from the
existing adapter, without a Send tap. After a trust dialog leaves, startup remains pending until
the launched agent and its normal composer are both established. An observed agent exiting ends
the launch intent. Once startup completes, later unknown screens retain the existing manual Send.
The existing poller watches initial startup at its hot cadence for at most twenty seconds; that
clock never establishes readiness or enables Send.

A message already submitted by an older client or a startup race can still be held by the bridge.
Only a normal message positively read at a modeled, frameless trust dialog receives private
`startupTrust` evidence. It resumes after two consecutive free poll reads and the regular Send
Protocol's fresh S0 verification. Commands, draft holds, unreadable dialogs and later messages
queued behind it keep their existing release rules. The mark survives restart and never appears
in the public held-row wire shape. No Trust decision is automated.

A live Pixel 7 browser tested the built app from `origin/main` at `1218fa59` plus this fix, against
an authenticated loopback-only scratch bridge and isolated Herdr. The local bridge probed Kiro's
send profile as 2.33.1, provisional. Three cases passed:

- New page → Kiro → fresh folder: trust appeared without sending; a typed draft remained local
  through Trust and composer initialization, with no Send receipt created.
- A normal Send submitted through the authenticated API while trust was open (the older-client
  race) was held without keys, then sent exactly once through the normal protocol after Trust.
  It completed about 5.4 seconds after the Trust tap and 2.1 seconds after the first observed free
  composer; replaying the request did not submit it twice. These are observations, not deadlines.
- Don't trust exited Kiro: the pending message ended with its text retained and nothing typed into
  the remaining shell.

Screenshots and structured results are retained locally in `.screenshot-bugs/kiro-startup-queue/`.
All scratch services were stopped. This focused live check does not claim a full model-turn
browser release-gate run.

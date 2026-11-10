# 0140: a screen Collie cannot read is sent to by the probe, on any layout

- **Status:** Proposed (2026-11-04, amended 2026-11-10), not built; for the maintainer to accept or
  turn down
- **Date:** 2026-11-04, amended 2026-11-10 with a throwaway PoC of both panes' versions (pi 1.4.0 +
  `pi-sidebar-tui` 1.7.8, Hermes v0.23.0 Ink, Herdr 0.9.5, tmux 3.8) against a logging fake model
- **Shipped in:** pending
- **Trail:** the blind road, taken by three Herdr phone relays that send without finding a box:
  [0cv/herdr-mobile-relay](https://github.com/0cv/herdr-mobile-relay) (`internal/herdr/client.go`
  `Prompt`, which runs `herdr agent prompt`), [dcolinmorgan/herdr-remote](https://github.com/dcolinmorgan/herdr-remote)
  (`relay/herdr_relay.py`, `send_text` and `agent_prompt`) and [finik/shepherd](https://github.com/finik/shepherd)
  (`lib/state/app_state.dart` `send`: `pane.send_input`, 250 ms, Enter), all resting on Herdr's own
  `agent prompt` (herdr `src/app/api/agents.rs`) · the per-layout road, proposed for these two panes
  on 2026-11-04 and turned down by the operator as ad hoc: a crop for one pi extension and a profile
  for Hermes's Ink front end · `bridge/surface/protocol.ts` (`gateSend`, `gateManual`, `read`,
  `bottomWindow`) · `bridge/launch-window.ts` · `web/src/lib/harness/pi/panel.ts` ·
  `web/src/lib/column-range.ts` · `web/src/lib/surface/profiles/hermes.json`, `pi.json` ·
  [ADR 0009](./0009-a-generic-menu-is-driven-by-the-keys-it-names.md) ·
  [ADR 0048](./0048-the-input-box-is-found-by-its-own-frame.md) ·
  [ADR 0098](./0098-pi-questions-are-read-by-shape-and-footer.md)

## Context

**Two panes refused every send from the phone on the same day.** Each claim below is marked
*measured* (a capture, a replay or a receipt in `<stateDir>/sends/`) or *inferred* (read from the
code, not replayed).

| Pane | What the screen is | Measured |
| --- | --- | --- |
| Hermes 0.22.7 (`wC:pBB`, the Mac) | `display.interface: tui` starts Hermes's Ink front end, not the prompt_toolkit CLI the profile reads. No rules round the input: a status row `─ ready │ … │ 20m 42s │ ✓ 21m 51s │ …`, then ` ❯`. | capture |
| pi 1.4.0 | The `pi-sidebar-tui` 1.7.8 extension paints a dim `│` at one column on every row and its panel to the right. The profile's rules end in `$`, so `─────… │ ~/Projects/…` matches nothing. | replay: `findInputFrame` finds no box on the capture, and finds it once every row is cut at cell 204 |

**What the Send Protocol did with them.**

- Hermes 0.22.6 (`wC:pDA`): the first tap was refused `unconfirmed` (09:02:42). The confirm tap 13 s
  later was refused `not_free`, "The input box moved between two reads", with no S0 recorded: S0's
  two reads never agreed. *Measured* (receipts `f910e284`, `309d0d23`).
- Hermes 0.22.7 (`wC:pBB`): after the update restarted it, two sends ended `probe_failed` in the
  launch window, "The pane shows no hermes input box yet" (08:58). At 10:53 a send was refused
  `unconfirmed` and no confirm followed. *Measured.*
- pi (`w4:p3`): the first send went out blind at 15:23:06 (`no-profile`: Herdr had not named pi
  yet). pi's session file is stamped the same second and the pane shows no message, so the text was
  probably lost. 13 s later a send ended `probe_failed` in the launch window. *Receipts measured;
  where the first text went is inferred.*
- pi (`wA:p1`, the same sidebar, 2026-11-02): two `unconfirmed`, no confirmed send. *Measured.*

**Collie already has a send for a screen it cannot read: the manual Send.** On a profiled pane whose
box S0 cannot find (`unknown(no-match)`), the first tap is refused `unconfirmed` with the hash of the
rows the person saw. The confirm tap goes ahead only on the same hash, every such send is probed, and
the probe's landing spot is the box S1 and S2 compare against (`gateManual`, the protocol header).
No layout is needed for that. On these screens it fails at three points:

1. **The launch window cannot end.** It ends when a read finds the box or a probe shows in one. With
   no readable box it runs its whole 120 s and refuses before any key (`launch-window.ts`). *Inferred
   from the code; the receipts show it holding both panes.*
2. **The confirm cannot hold still.** S0 needs two reads that agree. `steadyRow` masks a timer only
   on rows the profile names as running rows, and the Ink status row's seconds clock is on no such
   list. *The refusal is measured; the clock as its cause is inferred, not replayed.*
3. **The rows hash covers the bottom 24 rows** (`CLUSTER_ROWS`), and the sidebar's live values sit in
   them. *Inferred.*

**The blind road would have sent on both panes.** Herdr's `agent prompt` refuses only when Herdr's
detector says the agent is `blocked`, or the agent is not the pane's foreground process. Otherwise
it pastes the text, waits a fixed delay and presses Enter. It never finds a box and never reads the
text back. That is why the relays need no layout. It is also why they type into a picker Herdr
reports as idle, and append to a draft already in the box: the screens ADR 0009 and ADR 0048 refuse.

**Collie took the blind road itself, once.** A pane with no profile is typed into and Entered blind,
with no probe, no S1 and no S2 (the `bridge/surface/protocol.ts` header). That is right for a shell.
It is wrong for a pane where an agent is starting before the multiplexer names it, and the launch
window that guards that case fails open: a foreground read that fails or times out counts as no read
(`launch-window.ts` header), so no window opens and the send falls through to blind typing. The pi
send at 15:23:06 went out `no-profile` that way. *The receipt is measured; that the foreground read
failed is inferred, not yet checked against it.*

**The cursor finds the probe, and it does not guard the send.** In the PoC the cell left of the
terminal cursor held the probe on pi with the sidebar and on Hermes Ink, so the cursor can say where
to look. In pi's own `/model` picker the probe landed in the picker's filter box and the same check
passed, so a cursor check alone would have typed into a picker. In Hermes's picker the probe did not
land. *Measured* (PoC leg D).

**The per-layout road works once per layout.** A crop keyed on `pi-sidebar-tui` fixes that
extension, a Hermes Ink profile fixes that front end, and the next sidebar or front end breaks again.
OmO's panel crop (ADR 0098, `pi/panel.ts`) is the precedent, and it lives in the phone's readers only:
the bridge's reads were never cut.

## Decision (proposed)

**Keep proving the box. Stop needing its layout to send.** Make the manual Send hold on any layout:

1. **One split-screen cut, for every harness, where a read becomes rows.** A separator glyph (`│`,
   `┃`) in the same display column on every row of the read, blank rows and rule rows included, is
   a split. Every row is cut there before a reader, the Surface or a compare sees it. Never when the
   same rows carry a border at column 0: that is a box filling the pane, not a split. It is one pure
   function under `web/src/lib/surface/`, called at the bridge's six read sites (`protocol.ts`,
   `shadow.ts`, `clear.ts`, `ask.ts`, `stop.ts`, `trace.ts`) and by the phone's readers. A read cut
   this way binds by `expected_columns` (`column-range.ts`). OmO's panel draws no separator, so its
   signs stay in `pi/panel.ts`.
2. **Ticking is observed, never listed.** S0 already reads twice. A row that differs between the two
   reads only in its digits is a ticking row: the stability check and the rows hash read its digits
   as a fixed mark. A row that changed in anything but digits still moves the screen. No profile names
   a clock.
3. **The launch window also ends on the multiplexer's word.** It ends when the multiplexer reports
   the starting harness `idle` or `working`. pi reports that from Herdr's own pi extension
   (`herdr-agent-state.ts`), not from the screen. Without such a report it ends as it does today.
4. **The multiplexer's `blocked` refuses a manual Send before any key**, as `herdr agent prompt`
   does. Collie's own reading decides everything else.
5. **A layout reader is a bonus, never a precondition.** A Hermes Ink profile or a sidebar sign
   turns the confirm tap into a free send. Sending never waits for one.
6. **No agent pane is typed into blind.** A pane the multiplexer names as an agent Collie has no
   profile for gets the manual Send: probed, and confirmed by a tap. A pane whose foreground read
   failed or timed out, and that the multiplexer has not named, is refused with the manual Send
   offered, never typed into. A plain shell in the foreground keeps today's blind send.
7. **The cursor may locate the probe; it never decides a send.** Where the multiplexer reports the
   cursor, it tells S1 where to look for the probe. Whether the box is free is still decided by S0,
   S1 and S2, and the confirm tap stays wherever Collie cannot read the screen.

Not chosen: the blind road, because it drops S1 and S2, and with them ADR 0009's refusal; a crop
or profile per layout, turned down as ad hoc; and the cursor as a gate, because leg D passed it in a
picker.

## Consequences

- **Both panes send after one confirm tap**, probed, with the text read back before Enter.
- **The confirm tap stays on every screen Collie cannot read.** That is the price of not trusting a
  state Collie cannot see. A Hermes Ink profile removes it for Hermes alone.
- **A changed number reads as the same screen** when it changed between S0's two reads and nothing
  else on its row did. A countdown in a dialog option is such a number. Only rows seen ticking are
  masked, never a row read once.
- **The cut can claim a real two-column program** whose divider spans every row. Its right column is
  dropped. If the input box sits in that column, the pane reads unknown, as it does today.
- **An agent the multiplexer has not named yet costs a tap.** A send in the first seconds of a
  fresh pane, or on a host whose foreground read failed, now offers the manual Send where it used to
  type blind. A shell pane is unchanged.
- **This governs the screen path only.** An agent that offers a door into its own live session (an
  inbox in pi, a second client of the Hermes gateway) needs no screen read at all; that is a decision
  of its own, still to be written. Panes without a door keep this path.
- **What a screen reads as changes**, so `SURFACE_VERSION` moves. The Send Protocol is touched, so the
  browser leg runs on Herdr and on herdr-core.
- **Open:** whether the 15:23:06 text was lost, and whether the foreground read failed or timed out
  there (point 6 closes that road either way; the receipt on the host is not yet read); where Herdr's Hermes state comes from (its plugin reports the
  session id; the state source is not confirmed); whether a sidebar clock alone breaks S0 (point 3
  above is not replayed).
- **Revisit** when the cap's counts (M56 spec 09) show the manual Send is the usual path for one
  harness: its layout reader is then worth writing.

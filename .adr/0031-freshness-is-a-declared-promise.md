# 0031 — Freshness, focus and shape are contract promises, not adapter folklore

Status: **Accepted** (2026-08-25)

Related: [ADR 0022](./0022-the-mux-seam-is-a-port-collie-owns.md) (the port these three promises are
added to) · [ADR 0008](./0008-collie-does-not-run-a-terminal-emulator.md) (why an adapter may
decline a thing rather than have one written for it) · [ADR 0009](./0009-a-generic-menu-is-driven-by-the-keys-it-names.md)
(the same rule one level down: act on what was declared, never on what was guessed) ·
[ADR 0007](./0007-the-idle-lock-is-a-pause-not-a-gate.md) (the phone's navigation is the operator's,
and it moves nothing they did not ask for).

## Context

The mux port made "which multiplexer" a question no route asks. Three questions were left over, and
each of them is the same shape: a fact about the multiplexer that the **UI needs**, that varies
between multiplexers, and that nothing in the contract stated — so each was answered by folklore.

**1. How soon does Collie see a change the operator made in their own terminal?** Herdr and tmux
announce a window opening or a tab being renamed. zellij announces nothing at all: its CLI has no
event verb, so the adapter censuses `list-panes` on an adaptive interval (M10/05). That difference
was real, it was documented in one adapter's header, and it was invisible above the seam. The phone
polled the bridge on a cadence, the bridge polled the multiplexer on another, and on a censusing
adapter a rename could sit unseen for twelve seconds while the operator looked at a screen that gave
them no reason to doubt it. The UI could not say "this may be a few seconds stale" because it had no
way to know that it might be, and it could not offer "look again now" because there was no verb to
call.

The tempting fix is measurement: have the phone time the bridge and infer staleness. It does not
work. A slow answer and a stale answer look identical from a phone on a tailnet, so a measured
number would report the network as staleness and a fast network as freshness — confidently, and
sometimes exactly backwards.

**2. Whose focus is `MuxPane.focused`?** The field existed and every adapter filled it in with
something. Whether "something" meant the pane the operator's own terminal is showing, or the pane a
control client last touched, or the session's last-active record, was per-adapter and unwritten. A
UI cannot build an affordance on a field whose meaning is three different facts.

**3. How many spaces can this multiplexer hold?** One on zellij, by construction — every zellij verb
is scoped to one session, so an adapter instance *is* one space (M10/05). Many on tmux and Herdr.
The space strip rendered a one-chip navigator on zellij: chrome that navigates nowhere, occupying
the top of a phone screen. The only way for the UI to have known better was to check the
multiplexer's name, which is precisely what the seam exists to prevent.

## Decision

**A multiplexer's freshness, its focus semantics and its shape are DECLARED by the adapter, and the
UI reacts to the declaration.** Concretely:

- **`refresh()` joins the floor of the port** — "look now": take one fresh listing and, if the watch
  is a census, reset it to its floor. It is not a capability, because every multiplexer can do it
  and it asks for nothing an adapter does not already do on its own schedule. It changes nothing, so
  `POST /api/refresh` is gated as a read and the live conformance probe may call it against a real
  session.
- **`topologyLatency` is declared beside the capabilities**, `push` or `bounded { ms }` — a *fact*,
  not a capability, because it answers "how fast" and never "whether". A `bounded` adapter states
  its **ceiling**: a bound that only holds while the herd happens to be busy is not a bound. It is
  published under `mux` in `/api/config`, and the home screen shows "synced Ns ago" only where the
  answer is `bounded`.
- **The bridge tells the watch whether anybody is looking.** `/api/snapshot` and `/api/pane/:id`
  stamp attention; it lapses after ten seconds. A censusing adapter tightens its cadence while a
  phone is reading; a pushing one ignores the word entirely. The declaration keeps stating the
  **idle** ceiling, because attention is something the bridge observes and never something a caller
  can promise.
- **Every phone-initiated mutation refreshes before it answers**, so the strip is right on the next
  poll rather than a census later.
- **`MuxPane.focused` means one thing: the pane the operator's own terminal is showing.** Moving it
  is a separate, declared capability (`setFocus`) behind a named tap, never a side effect of
  navigation.
- **`spaces: "one" | "many"` is declared**, and the space strip renders nothing when a multiplexer
  can only ever have one.

Every cell is probed before it is declared, and the probe is cited in
[`MUX_CONTRACT.md`](../MUX_CONTRACT.md) — an unprobed cell is never declared supported.

## Alternatives rejected

**Measure freshness from the phone instead of declaring it.** Rejected above: on a tailnet a slow
answer and a stale answer are the same observation, so the number would be wrong in both directions
and would be presented with the authority of a measurement.

**Find a topology event for tmux and zellij after all, and delete the whole question.** Evaluated
2026-08-24; none of the candidates yields a topology event the seam lacks:

| Candidate | Why it does not answer the question |
| --- | --- |
| tmux `-CC` (control mode with echo) | The same stream as `-C`, which the adapter already runs, plus terminal echo. It adds no notification; the gap on tmux was never the event, it was the sessions no control client is attached to and the tmux versions with no control mode at all. |
| tmux `wait-for` | A **rendezvous primitive**, not a feed: it blocks until somebody runs the matching `wait-for -S`. The somebody would have to be the operator's own config, so it reports only changes Collie taught the operator's `.tmux.conf` to report. Collie does not write an operator's config (the same rule that makes the `window-size` guard *refuse* rather than repair). |
| tmux `set-hook` | Real, and the same objection: a hook is a line in the operator's server configuration. Collie would be mutating a global setting on a server that runs the operator's own sessions, to learn something a 5 s listing already tells it, and would leave the hook behind on every server it ever touched. |
| zellij `dump-layout` | A **snapshot serialiser**, not a watch. It answers the same question `list-panes` + `list-tabs` already answer, in a format the adapter would have to parse a layout language out of, and it still has to be called on a schedule. |
| zellij `list-clients` | Reports who is attached and what they run. It does not report tabs or panes appearing, and it changes only when a client does — so a herd being reshaped by the operator's own keyboard moves nothing in it. |
| zellij `pipe` / the plugin API | This is where such an event genuinely lives, and it needs a WASM plugin loaded into the operator's session. That is a second artefact to build, ship, version and install on every host — for a notification a bounded census already delivers within a stated bound. |

So the census stays, and the honest answer is to **state its bound** rather than to keep hunting for
an event that is not on the command line.

**Sync focus both ways automatically** — a mode where opening a pane on the phone also moves the
operator's terminal to it. Rejected, and this is the one that would have been easiest to ship. A
phone is a browsing surface: an operator scrolls the herd, opens a pane to read it, backs out, opens
another. A terminal is a working surface with a cursor in it and somebody's hands on the keyboard.
Wiring the first to the second means a glance at a phone in a pocket-adjacent moment yanks a live
session out from under whoever is typing in it — and it does so *silently*, because the person at
the keyboard did not touch anything. Navigation must never move a human's terminal as a side effect.
The phone therefore moves the terminal's focus **only** on a named tap ("Show in terminal"), and the
reverse direction — the terminal moving the phone — is opt-in, off by default, and refuses while the
operator is typing.

## Consequences

- A new adapter must answer three more questions before it can be registered, and the compiler asks
  two of them (`topologyLatency` and `spaces` are required on the declaration; `refresh()` is
  required on the port). That is the intent: the failure this ADR closes off is a fact nobody was
  ever forced to state.
- The conformance suite grows a perturbation every fixture can simulate — a structure change that
  **announces nothing** — and checks that `refresh()` then `snapshot()` shows it. It also checks
  that a `bounded` declaration carries a real number, because a bound of zero is not a fast adapter,
  it is an unstated one.
- `topologyLatency` is absent on a bridge older than this decision, and the phone reads that absence
  as `push`. That is the opposite fail-open direction from a capability's, deliberately: a
  capability defaults to present because hiding a working control is unfixable, while this defaults
  to `push` because inventing a staleness counter for a bridge that never claimed to be stale is
  noise the operator cannot act on.
- Nothing about the pack wire changes. `/api/refresh` is not on `apiPathFor`'s allowlist, so a lead
  reaches a peer's freshness through the pane and snapshot routes it already calls
  ([ADR 0011](./0011-the-pack-protocol-is-the-mux-driver-seam.md)).

## Amendment

2026-08-25: the Follow terminal toggle was removed as unnecessary; the rule that the phone never
moves the terminal except via "Show in terminal" stands.

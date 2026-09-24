# 0049 — "Fit to phone" is a named, leased geometry write

Status: **Accepted** (2026-09-24)

Supersedes [ADR 0008](./0008-collie-does-not-run-a-terminal-emulator.md) on its **geometry clause
only** — the 2026-09-05 amendment's "a pane's geometry is the operator's screen, and Collie does not
write it". The emulator refusal, the `StyledLine[]` client contract and the cell-grid refusal stand.

Related: [ADR 0031](./0031-freshness-is-a-declared-promise.md) (the named-tap rule this write lives
under, unchanged) · [ADR 0022](./0022-the-mux-seam-is-a-port-collie-owns.md) (the port the capability
is declared on).

## Context

A full-screen TUI in a Herdr pane is drawn at the desktop's width. The mirror shows it faithfully —
and on a phone that means panning a 120-column dashboard through a 48-column window. The TUIs that
hurt most here already carry a narrow layout (the case that reopened this: an OpenTUI console whose
menu stacks below 60 columns); they never see a narrow terminal, because nothing ever gives them one.
Wrapping cannot help a box-drawn screen, and ADR 0008 rightly refuses to re-render it. The only fix
is the one 0008's amendment forbade: change the PTY's size.

0008 argued from two facts. One was that `pane.zoom` / `pane.resize` are inert on a detached PTY —
still true, and still why neither is used here. The other was that `terminal session control` was
**unprobed**, and that it would fight the desk. It has now been probed.

### What `control` does (probed 2026-09-24, herdr 0.9.1, protocol 22, Windows ConPTY)

Each row below was observed in a throwaway named session, never the operator's own. The full log
sits in [`HERDR_API.md`](../HERDR_API.md) § *`terminal session control` — the geometry lease*.

| Situation | Observed |
| --- | --- |
| `control <terminal> --cols 50 --rows 30`, no desktop client | The PTY became 50×30: a shell loop reading `[Console]::WindowWidth` printed `50x30`. A real OpenTUI console redrew in its stacked layout at 48×36 and kept taking keys over `pane.send_keys`. |
| The controller exits (stdin EOF), no desktop client | The PTY **stays** at the leased size. The next desktop attach re-imposes the desktop's rect (a stale 45×22 became 93×29 on attach). |
| The same, desktop client attached | Herdr re-imposes the desktop's rect at once (93×29; after a split during the lease, the new 44×27). |
| The controller is killed (`taskkill /F`), desktop attached | The same as a clean exit: the desktop's size returned within a second. |
| A desktop layout change (a split) while the lease is held | The lease wins; the PTY stays at the leased size until release. |
| A second `control` without `--takeover` | Refused: `terminal.closed` with `terminal attach failed: … already has an attached client; retry with --takeover`. A desktop client does **not** count as an attached client. |
| A second `control` with `--takeover` | The first controller is closed with `terminal attach taken over`; the second's size applies. |
| `observe --cols 30 --rows 20` | Never changes the PTY. Its frames are drawn at the observer's size, so `observe` cannot report the PTY's size either. |
| `pane.layout`'s rect | 120×40 over a PTY the program measured at 119×40, and unchanged by a lease. It is not the PTY size. |

One platform note: on Windows a process learns of a ConPTY resize only while it reads stdin in raw
mode (libuv delivers the console's buffer-size event on that read). A Bun script that never read
stdin kept `119x40`; the same script with `setRawMode(true)` got `resize` and `SIGWINCH` at once.
Every full-screen TUI reads stdin raw, so this binds nothing Collie would fit; it is recorded so a
probe with a silent test program is not mistaken for a Herdr failure.

So the second fact inverts. `control` **does** move a detached PTY — the one case `pane.resize`
cannot reach — and the moment it is released Herdr hands the size back to whoever is at the desk,
with no restore size for Collie to compute or get wrong.

## Decision

**Collie writes a pane's geometry in exactly one way: a "Fit to phone" lease, started by a named tap
and never by navigation.**

- **The tap is the only trigger.** Opening, scrolling or returning to a pane never fits it
  (ADR 0031's rule, applied to a second write). There is no auto-fit setting.
- **The lease is one `herdr terminal session control <terminal> --cols C --rows R` child per pane,
  owned by the bridge.** `C` and `R` are the phone's measured mirror, clamped to a floor. The child's
  stdout is drained and **discarded, never parsed**: Collie holds the size, it does not read frames.
  The mirror stays `pane.read`, and 0008's emulator refusal is untouched.
- **The phone renews the lease while the pane view is open; it lapses two minutes after the last
  renewal.** Leaving the pane view (back, a pane switch) releases it at once. A hidden page or a lost
  connection simply stops renewing, and the grace period is what keeps a pocketed phone from
  pinning a desktop's pane.
- **Release is ending the child, and nothing else.** Restoring is Herdr's: with a desktop attached it
  is exact and immediate; with none, the next attach sets it. Collie never writes a "previous" size —
  it cannot know the PTY's size (`observe` and `layout` both answer something else), and the one
  party that does is already doing it.
- **Collie never passes `--takeover`.** A terminal another controller holds answers `busy`, and the
  phone says so. Re-fitting its own lease (the phone rotated) replaces Collie's own child.
- **It is a declared capability, `fitToPhone`, and only Herdr declares it.** tmux and zellij are
  unprobed and answer `unsupported`.
- **A bridge that stops, ends every lease child**, which is a release like any other.

## Alternatives rejected

**Fit automatically when a phone opens a pane.** Rejected on ADR 0031's own ground: a glance at a
phone would re-lay-out the desktop's pane under whoever is typing in it.

**`pane.zoom` / `pane.resize`.** Inert on a detached PTY (`herdr#1709`, 0008's amendment), so they
fail in the only case that motivates fitting.

**Resize back to a remembered size on release.** There is no honest number to remember: `layout`'s
rect is a column off the PTY, and `observe` reports its own size. Writing a guess back would also race
a desktop that re-imposes its size anyway.

**Take over a terminal another controller holds.** That turns a second phone, or a future tool, into
a tug-of-war over one PTY, with the loser's view silently reflowing. A refusal the operator can read
costs nothing.

**Parse the `control` frames while the child is open anyway.** That is the emulator, by another door.

## Consequences

- **While a lease is held, the desktop's pane shows the program at phone size.** The operator asked
  for that by name, and it ends on release; this is the "fights the desk" cost 0008 named, accepted
  here because it is chosen, bounded to two minutes of silence, and reversed by Herdr itself.
- **The bridge owns a long-lived child process per fitted pane**, the riskiest I/O 0008 warned of.
  It is kept inert on purpose: no parsing, no input over its stdin, stdout drained so it can never
  back up, and every child ended on shutdown.
- **A phone-sized PTY outlives the lease when nobody is at the desk**, until the next attach.
  Accepted: nobody is looking at it, and the attach fixes it.
- **A second phone cannot fit a pane the first one holds.** It sees `busy` until the first releases
  or lapses.

### What would justify revisiting

- **Herdr putting the real PTY size on the pane record** (0008's third revisit clause). Collie could
  then show the fitted size honestly and refuse a fit that would change nothing.
- **A per-client viewport in Herdr**, so that a phone could size its own view without sizing the
  PTY. That would retire this lease entirely.
- **Evidence that the two-minute lapse pins desks in practice.** Shorten it; do not add a restore.

# 0044 — The update screen is one reducer and one shared poll

**Status:** accepted, 2026-09-13

## Context

A running Collie update has three independent truths, and for three releases they were read on three
surfaces with three rules.

1. **The run record** — `preflight`, `staging`, `restarting`, `verifying`, then `done`,
   `rolled-back`, `stuck` or `interrupted`, plus a leg per crew member. It is served by the front
   door and, while the bridge it is served from is deliberately down, by the standby door on a second
   port.
2. **The service worker** — this device fetching the new app bundle into its precache. Its only
   states are `idle` and `installing`, and since 2026-09-12 the page reloads on the controller swap
   and on nothing else.
3. **The device that tapped** — a module-scoped fact about one document, which is the only thing that
   can say whether this screen asked for the update or merely heard about it.

Three surfaces read them. The band above the header had five run states of its own; the Updates card
had a run section, a peer census and its own standby-door timer; and `lib/self-update.ts` held the
bundle reload for the length of a run. Each interpreted the same record with its own rule, and the
bills came in:

- **2026-09-07.** The band asked "did the run finish under ten minutes ago?" and the card asked "does
  the record still list a moving peer?". At ten minutes the band went quiet over a card that kept the
  same peer moving for five more. M20 fixed it by giving both surfaces one reading, `readRun`.
- **2026-09-07, again.** One forty-character row had to say "Restarting", "Updating 2 peers" and "Tap
  to reload" about three different things, and could only say one. The operator tapped a dozen times.
- **2026-09-12.** The band said "Updated, tap to reload" while the new worker was still installing,
  the tap reloaded onto a shell that was about to be deleted, and React never booted.

Every one of those is the same shape: a fact with more than one reader, and no one place that decides
what the screen says.

Two costs were weighed and accepted rather than avoided. The sheet has to be a SIBLING of the node it
makes `inert`, because a node cannot be both inert and the host of the dialog that made it inert — so
it is mounted in `web/src/App.tsx` beside the wrapper holding `BusyBar` and `RouterProvider`, next to
`IdleLock`, and therefore has no route loader data and no `CrewProvider`. And the service worker's
only progress hook, `fetchDidSucceed`, fires once per completed asset and carries no byte count.

## Decision

**One pure reducer decides the whole screen, one shared store owns the poll, and progress is counted
in files.**

1. **`web/src/lib/update-screen.ts` is the only place the update screen is decided.** It is pure: no
   React, no clock, no store read. It returns `{ mode, dismissible, rows, device, end, … }`, and
   **`dismissible` is decided there and nowhere else**. The rule is one sentence: it is false while a
   run THIS DEVICE STARTED is IN FLIGHT, and true otherwise. A settled run is therefore never
   undismissible, by construction rather than by a check somebody has to remember.
2. **Precedence, which other code must follow.** The run truth is **the newest of the front-door read
   and the standby door**, by `updatedAt`, with a tie going to the liveliest source — the rule
   `freshest()` already applied on the Updates card, now in the store. And **the worker stage and the
   run state are independent truths**: `done` plus `installing` is a legitimate combination, not a
   conflict. The machines finished; this phone is still fetching the app they now serve. The reducer
   renders both rows and waits for the controller swap.
3. **The run states leave `ribbonView`.** The band keeps what is not a run: a release on offer, a
   terminal peer leg with its reason, a stale bundle, and a bundle downloading with no run behind it.
   A forty-character row repeating a full-screen sheet is the 2026-09-07 fault with a new sheet under
   it.
4. **One store, `web/src/lib/update-run-store.ts`, owns the front-door read, the standby-door
   interval and the reconciliation.** The Updates card's own timer moves into it. Two mounted
   surfaces must never poll the standby door twice: it is a second listener on a second port, armed
   by silence, and asking it twice is asking the deputy to answer for a page that already knows.
5. **Progress is counted in FILES.** `web/src/sw.ts` adds a precache plugin whose `fetchDidSucceed`
   posts `{ done, total, url }` to every client, and `total` is the manifest's own length. There is no
   build-time size stamp, no `dist/precache-sizes.json`, and no `HEAD` per entry.
6. **Every threshold is a named constant in the reducer's file, with its reason at the line**:
   `PEER_UNREACHABLE_MS`, `DOWNLOAD_HUNG_MS`, `LEAD_STALLED_MS`. Each one's way out is "keep the app
   you have". None of them cancels a run, and none of them reloads the page.

## Consequences

- **The sheet pays for its position.** No loader data and no crew context, which is exactly why the
  store exists and why `routes/root.tsx` publishes the snapshot's run and this machine's name into
  it. A future surface that needs either inside the router should read the store too, not add a
  second reader of the route.
- **`inert` and `useDialogFocus` are both kept.** `inert` removes the app behind from the focus order;
  it does not move focus into the sheet. iOS Safari has supported `inert` since 15.5, which is below
  any iOS this PWA targets.
- **A byte-level progress bar is closed off here.** It needs a hook `fetchDidSucceed` is not, and it
  would still move in file-sized jumps. Wanting one is wanting a different mechanism, and that is its
  own decision, not a tweak to this one.
- **The cross-product is the test.** Nine run states by two worker stages by started-here or not by
  the controller swapped or not is seventy two rows, each pinning a mode and a dismissible value
  (`web/src/lib/update-screen.test.ts`). The odd pairs are rows like any other, which is what stops
  somebody "fixing" `done` plus `installing` into a conflict.
- **Every tab of the origin still reloads on the controller swap.** That is unchanged by this record
  and remains the decision in `web/src/lib/pwa.ts`: choosing which tab reloads would be a
  BroadcastChannel design and belongs in that file, not here.

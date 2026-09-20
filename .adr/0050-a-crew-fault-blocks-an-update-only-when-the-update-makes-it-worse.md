# 0050 — A crew fault blocks an update only when the update would make it worse

- **Status:** Accepted
- **Date:** 2026-09-20
- **Shipped in:** points 1 and 2 pending release; point 3 not yet built
- **Trail:** `cli/update-check.ts` (`doctorCheck`, `skewCheck`) · `bridge/update-action.ts`
  (`mergedUpdateVerdict`, `crewUpdateRows`) · `cli/crew-update.ts` (`preflightGate`) · `cli/doctor.ts` (the `local` and
  `crew` finding lists, `reach`) · `web/src/components/update-card.tsx` (`blocked`,
  `blockedReason`) · [ADR 0045](./0045-a-build-below-the-protocol-floor-is-a-red-preflight.md), which
  argues the other road and is right about its own case · the 2026-09-20 incident below

## Context

**A laptop went to sleep and the server could not be updated.** On 2026-09-20 the lead was on 1.11.0,
1.11.1 was published, the ribbon offered it, and the confirm was disabled. The whole chain:

```
preflight: red
  doctor  — collie doctor reports 1 problem: member-reach

collie doctor
  ERROR member-reach
    1 of 1 did not answer: minibuch at minibuch…:8788
    unreachable — hello: timed out after 5000ms
```

`tailscale status` said `minibuch … offline`; ssh to port 22 timed out. The member was asleep. The
lead was healthy, had the disk, the bun and a clean tree, and could have taken the release in
seconds.

**The preflight asks one question, and a crew fault is not an answer to it.** Every other check in
`collie update --check` is about this machine's ability to take a new version: free disk, a bun at or
above `MIN_BUN`, no tracked-file changes, a tag that resolves, a service that can restart. `doctor`
is the odd one out, because `doctor` is a general health report and `doctorCheck` folded every error
in it into one red verdict with no distinction.

**The code already draws the line it then throws away.** `cli/doctor.ts` builds two lists:

```ts
const local: Finding[] = [ …this machine… ];
const crew: Finding[] = inCrew && data !== null
  ? [ storeDrift(…), secretGeneration(…), reach(…), memberVersions(…) ]
  : [];
const findings = [...local, ...crew];
```

The terminal renderer already prints them as two sections. Only `doctorCheck` flattens them. Not one
of those four crew findings is a precondition for this machine building, swapping and restarting.

**And the crew is designed for a member that is not there.** A peer levels itself to whatever release
its lead is running when it comes back (ADR 0016's 2026-09-04 addendum, `bridge/crew/follow.ts`), and
`CREW_PROTOCOL.md` §7.1 states that a build-version difference between lead and member refuses
nothing. "Update the lead now, the laptop catches up when it wakes" is the designed flow, not a
workaround for a gate.

**The normal case must not trip the gate.** A laptop that sleeps is not a fault; it is what laptops
do. A crew of one desktop and one laptop had the update button disabled for most of every day. A gate
that fires on the ordinary case is a gate an operator learns to route around, which costs the gate its
authority over the cases that matter.

**ADR 0045 argues the other road, and it is right about its own case.** It makes a member below the
protocol floor a RED preflight that blocks the confirm — a crew-level fact deliberately stopping this
machine's update. The two are not in conflict, and the reason why is the decision below: a member
below the floor is made **permanently** unreachable by the lead moving, because the overlap release it
needed is already behind it. An absent member is made no worse at all. One is stranding a machine; the
other is waiting for a lid to open.

## Decision

**A crew fault blocks an update only when taking the update would make that fault worse. Absence does
not.**

1. **`doctorCheck` goes red on a LOCAL error only.** A crew error makes it **amber**, which is
   reported on the card and does not block. The split is the one `cli/doctor.ts` already builds, so a
   finding carries a `scope` field (`local` | `crew`) and `--json` readers see it. **No list of check
   ids.** An id labels a sentence and can be renamed; the scope is the fact (the same rule ADR 0035
   applies to install kinds).

   **The amber reason names the check ids, never the finding's `detail`.** Every check's reason is
   rendered verbatim on the phone, in the update card's preflight list
   (`web/src/components/update-card.tsx`), and a red one also becomes `blockedReason` on the card
   itself. A `detail` is free prose written for a terminal: `reach` builds
   `minibuch at minibuch:8788 — <why>`, so a real host and port would ride the reason into the phone
   UI, a screenshot and a log. No preflight reason is translated, so the choice is not between
   English and German, it is between an untranslated IDENTIFIER and an untranslated SENTENCE, and
   the card already prints check ids in monospace beside translated text. An id also has a closed,
   bounded vocabulary that this ADR governs; a detail is unbounded prose. Every crew error is listed
   rather than the first, because two at once is ordinary and reporting one hides the other. Naming
   the MACHINES is point 3's job, from the roster the phone already holds.

   **`store-drift` is rendered with the crew and is NOT stamped as a crew fact.** It compares this
   machine's running bridge to this machine's own trust store, needs no answer from anywhere else,
   and its remedy is `collie restart` here, so by the field's own meaning it is local and stays red.
   That is also the right answer on a PACKAGED install, where `doctorCheck` still runs but
   `collie update` refuses outright (ADR 0035): amber there would have claimed "this machine can
   still update" on a machine whose update is refused, and buried a real local fault under the
   package-manager sentence. This is the clearest case that the stamp is per check and not a group
   pass: `store-drift` sits in the crew ARRAY, and is not a crew FINDING.

   **The stamp is not a group pass.** The rule is applied to each crew check on its own terms, and
   the argument for each of the four is recorded at the list in `cli/doctor.ts`. Only `store-drift`
   and `reach` can be errors at all; `secret-generation` and `member-versions` are `warn` at worst,
   so this decision never touched them. A fifth crew check is argued there before it is added.

2. **What `unknown` means at the gate that starts the update.** Decision 1 governs
   `doctorCheck`, which is what disables the BUTTON. It is not what refuses the TAP. `POST /api/update`
   calls `mergedUpdateVerdict` (`bridge/update-action.ts`), and that returns `blocks: true` for any
   member row whose verdict is `unknown`. A row is `unknown` when the lead holds no banked preflight
   for that member, and the bank is in memory only, cleared by `disposeAll()` on shutdown.

   **So the fix lasts until the lead's next restart, which the update itself performs.** The laptop
   sleeps at 18:00. The desktop takes the release at 20:00, which decision 1 now allows. That update
   restarts the desktop's bridge and empties the registry. The laptop is still asleep. The next
   morning the card's button is live, because `blocked` in `web/src/components/update-card.tsx` reads
   only the lead's own red, and the tap returns 412 `update.preflight_red`. That is the 2026-09-20
   incident again, wearing a worse face: a live button that refuses. It did not show on the day only
   because the desktop had not restarted since the laptop slept, so a failed sweep kept the member's
   last banked green.

   **So: an `unknown` member whose registry health is `unreachable` does not block the LEAD's own
   start**, and `unknown` keeps blocking a PEERS-ONLY run, where the members are the whole point of
   the request. `mergedUpdateVerdict` takes a `tolerateAbsent` option, set at the lead's own gate and
   left off at the peers-only one. The verdict still READS `unknown`, so the card can name the
   machine and say it will be skipped; it simply stops refusing the tap.

   Health reaches the row to make this possible: `CrewUpdateRow.health` is additive-optional, and
   `bridge/crew/lead.ts` fills it from registry state. Absent health means "no idea why", which is
   uninspected rather than absent, and still blocks. The lead's own row never carries a health, so a
   lead with no report of its own still blocks, which is what it should do. A member that is red is
   still read before any of this: red is decided first, absent or not.

   **ADR 0045's floor check is untouched, and its blind spot is named rather than patched.**
   `skewCheck` is its own preflight check on the member walk, not a `doctor` finding, so narrowing
   `doctorCheck` cannot disarm it. It needs the member's version, so a member that does not answer has
   no floor check. A guard for that was written and then deleted, because it could not fire: it
   compared this lead's own version against `FLOOR_ENFORCED_FROM`, and every binary that contains the
   guard is newer than that constant, while a lead old enough to trip it is running the old code that
   blocks on any error anyway. It would have come alive at the NEXT protocol bump and then fired for
   the whole overlap window rather than at the crossing, re-creating this very incident exactly when
   leads most need to move.

   The edge is therefore accepted, as ADR 0039 makes a floor crossing a planned event with a stated
   overlap. **The next protocol bump must decide the silent-member case**, with two facts in hand that
   this ADR's draft wrongly said did not exist: the target version, which `upstreamCheck` already
   resolves, and the member's last reported version, which the lead holds in `CrewRegistry` and sends
   to the phone as `CrewUpdateRow.version`. That bank is in memory by design, because a version
   describes a running process; a last-seen version is a LOWER BOUND while the member stays enrolled,
   and a lower bound is what a floor check needs. It does not belong on `OpsRecord`, which records
   what the operator did from this machine, nor on `TrustedMember`, which is a secret file.

3. **The card names the members that are already not answering, before the tap.** A crew update with
   an unreachable member is allowed and says what it will do:

   > minibuch is not answering. It will be skipped, and it levels itself when it comes back.

   The run still goes. The leg still ends `unreachable`. The operator was told first, so a red row is
   confirmation rather than a surprise.

   **Not built yet.** Points 1 and 2 land first because they are what unblocks a healthy machine.
   The card reads the fact it needs from the crew roster it already holds (`lib/host-health.ts`), so
   this needs no new wire field, only the sentence and its six translations.

## Consequences

**A degraded crew no longer stops a healthy machine updating.** That is the point, and it is a
loosening: an operator who read a disabled button as "something is wrong with my crew" now reads an
amber line instead. The line says the same thing; only its authority over the button changes.

**A crew update with an absent member ends in seconds, not in twenty minutes.** `LEG_OPEN` is
`{waiting, updating}` and `unreachable` is terminal, so a member that misses `TURN_MISSED_SWEEPS`
sweeps settles its leg and the run with it. The twenty-minute wall clock is not reached.

**Crew state folds into the lead's own move in FOUR places, and this ADR changes one.** Saying so
plainly, because the draft read as if it changed all of them:

| gate | who reads it | before | after |
| --- | --- | --- | --- |
| `doctorCheck`, via doctor's `reach` and `clock` | the card's button | red | **amber** |
| `mergedUpdateVerdict`, an `unknown` row | the tap, `POST /api/update` | blocks | **tolerated when absent** |
| `skewCheck`, on the CLI member walk | `collie update --check` in a terminal | red | unchanged |
| `preflightGate`, `cli/crew-update.ts` | `collie crew update` | refuses the whole run | unchanged |

So "a member that would be stranded still blocks the confirm" is true on the terminal only, and a
sleeping member still refuses `collie crew update` outright. Decisions 1 and 2 cover the phone's two
gates, which is where the incident was; the two terminal gates are unchanged and are named here so
nobody reads this ADR as having moved them.

**The stamp is per finding, never the array.** `cli/doctor.ts` builds a `local` list and a `crew`
list, and those are RENDER SECTIONS. Two findings cross: `store-drift` prints with the crew and is
local, `clock` prints with this machine and is a crew fact. Each is stamped at its own line. The two
warn-only crew checks are held to `warn` by a test that reads the source, so a future `bad(` in either
is a failing test rather than a silent downgrade to amber.

**The LOCAL list was not audited under this rule, and that is a known gap.** The Decision heading
states a rule about faults; the code applies it to crew faults. `web-dist`'s remedy is `collie build`,
which an update performs, so it is arguably not a precondition either. The honest end state is an
explicit allowlist in `doctorCheck` of the doctor ids that really are update preconditions, failing
safe to amber on a rename, with a test that each id exists. This ADR's objection to check ids is
weaker than it was written: `cli/finding.ts` already calls `check` a stable identifier that scripts
branch on, and this same change branches on `"member-reach"` and reports ids to the phone.

**What would justify revisiting this.** A crew fault that the lead's own update genuinely worsens and
that is not the protocol floor. Point 1 above is the test to apply, not the list of four findings: if
a fifth crew check is added and taking the update makes its fault worse, that check is red, and it
says so at its own line rather than by re-widening the gate.

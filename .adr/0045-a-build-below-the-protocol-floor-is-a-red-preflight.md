# 0045 — A build below the protocol floor is a red preflight, never a silent link

Status: **Accepted** (2026-09-13)

Related: [ADR 0039](./0039-the-machine-says-crew-too.md) (the rename that scheduled the removal this
answers) · [ADR 0016](./0016-updates-ride-the-operators-ssh.md) (the walk this check runs inside) ·
[ADR 0013](./0013-a-peer-listens-without-becoming-a-front-door.md) (what the link is) ·
`CREW_PROTOCOL.md` §7 (the exact-match window) and §7.1 (the rule this carves one exception out of)

## Context

**1.9.0 removes the overlap, and one cohort loses its footing.** 1.8.0 renamed every name a machine
reads on the crew link and kept a one-release compatibility layer so a 1.7.0 member could follow the
update roll (ADR 0039, `CREW_PROTOCOL.md` §0.1). 1.9.0 deletes that layer, as ADR 0039 said it would.
The cohort that feels it is narrow and real: a machine that was off for every 1.8.x release and comes
back under a 1.9.0 lead. It speaks protocol 1. The lead speaks only protocol 2.

**The link already says something, and it says it late and without a remedy.** The headerless ladder
in `bridge/crew/peer-client.ts` reads an answer with no crew protocol header as `unreachable` for the
first 60 seconds and then as `incompatible`, with a reason that ends "this build speaks 2".
`collie crew status` prints that verbatim. So the operator is not left in silence. What that line
never names is what to do, because the member answered no version at all, so there is no version to
report and no remedy to derive.

**The operator's own path holds both versions already.** `collie update --check` walks every member
over the operator's ssh (ADR 0016), asks each one for its preflight, and compares the version it
reports against this lead's. That comparison is `skewCheck`, and until now it was amber in every case
that was not an exact match, on §7.1's rule that a build-version difference refuses nothing. The
walk's rows are what gate the crew update: a red row blocks the confirm rather than starting a roll.

**So the question is not whether the operator finds out. It is whether the machine that knows both
version numbers is allowed to say the obvious thing.** §7.1 forbids it in the general case, for a
good reason: a crew that goes dark over an alpha number has traded an annoyance for an outage. The
skipped-release case is not that case. It is not skew inside a protocol version, it is a member
outside the only protocol version left.

## Decision

**A member whose build is below the protocol floor is a RED `version` check on the lead's preflight,
naming both versions and the remedy. The floor is a named constant, tied to the protocol number.**

- **`PROTOCOL_FLOOR_VERSION` (`cli/update-check.ts`) is the oldest build that speaks the current
  `CREW_PROTOCOL_VERSION` (`bridge/crew/enrollment.ts`).** Protocol 2 first shipped in 1.8.0, so the
  floor is `1.8.0`. The two are one fact, not two constants that happen to agree: whoever moves the
  protocol number moves the floor in the same commit, and a test in `cli/update-check.test.ts` fails
  when they drift apart.
- **The red arm fires only when this lead is at 1.9.0 or newer.** 1.9.0 is the release that dropped
  the overlap, so it is the first lead for which the floor is true. A 1.8.x lead still answers the old
  prefix, and a red row there would refuse a link that works.
- **A version this lead cannot read stays amber.** An empty string, `unknown`, a prerelease
  (`1.8.2-rc1`), a development suffix (`1.9.0-dev`) and anything else that is not a plain `X.Y.Z`
  take the amber arm. An unreadable version is not a known-old one, and a build the operator chose is
  not one the lead should refuse on a suffix.
- **The wire does not change.** No route, no header, no state, no timing, and no new refusal on the
  link. The headerless ladder reaches `incompatible` exactly as it does today. This is a verdict on a
  report, made before an update is started.
- **A 1.7.0 state directory is named, never adopted.** The one-time `pack-*.json` rename goes with the
  overlap. A collie that finds `pack-trust.json` without `crew-trust.json` prints one line at start
  naming both hand edits in full, and stays solo. The line repeats on every later start until it is
  obeyed, and it costs one `exists()` on the boot path, never on the trust store's read or write.

## Consequences

- **§7.1 gains its one exception, and it is fenced.** The rule "a build-version difference refuses
  nothing" is now true of the wire and false of one preflight row. §7.1 says so at the line, so a
  reader cannot find the rule without finding the exception.
- **The operator gets a remedy instead of a diagnosis.** The red row names the member's version, the
  lead's version, the protocol fact and the command, and it blocks the crew update rather than
  starting a roll that cannot finish.
- **The phone sees the block without new UI.** The Updates card draws every preflight row it is
  given, so a new check id draws itself. The skew row itself is a CLI row, because the phone's report
  is the lead's own `--local` one. What the phone gets for the same member is the crew row that
  already exists: `unknown`, "we could not check <name>", which already blocks the confirm.
- **The floor is a thing to move, forever.** Every protocol bump now has two edits instead of one.
  That is the cost of the tie, and the test is what makes forgetting it loud rather than silent.
- **An operator who jumps 1.7.0 to 1.9.0 hand-edits a secret file.** That is the honest cost of
  removing the rename on schedule. The notice prints the edits so nobody has to find them.

### What would justify revisiting

- **A second overlap.** If a future rename needs more than one release of compatibility, the window
  is what gets the new ADR (ADR 0039 said this first), not the floor.
- **A floor that reads a range.** If `CREW_PROTOCOL_VERSION` ever has to express more than one
  accepted version, a single floor string stops being the whole answer and this record is reopened.

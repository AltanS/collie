# 0039 — The machine says "crew" too

Status: **Accepted** (2026-09-09)

Supersedes [ADR 0038](./0038-the-group-is-a-crew-the-wire-keeps-pack.md) on the machine-read names
only; the operator word, the roles, the verbs and the alias plan stand.

Related: [ADR 0012](./0012-every-machine-runs-a-collie-and-the-pack-has-a-lead.md) (the surface
classification and the landing rule this uses) ·
[ADR 0011](./0011-the-pack-protocol-is-the-mux-driver-seam.md) (what the protocol is) ·
[ADR 0025](./0025-the-wire-guard-forces-a-decision-never-a-bump.md) (the guard that fires on the
wire files) · [ADR 0016](./0016-updates-ride-the-operators-ssh.md) (the update roll this has to
survive)

## Context

**1.7.0 shipped a split, and it was never chosen.** ADR 0038 renamed the word a person reads and
froze every name a machine reads: the wire paths and headers, the two environment keys, the three
state files, the journal prefix, the protocol document, and every identifier in the tree. The
reasoning was the rename cost against a compatibility promise, and it was decided inside M24's
decision list rather than put to Altan as a question. Asked directly on 2026-09-09, he took the full
rename, and said he would have taken it in 1.7.0.

**A split vocabulary costs more than the rename it avoided.** A grep for "pack" in this tree answers
three different questions at once and settles none of them, which is the third complaint ADR 0038
itself recorded against the word. Keeping the machine names left that complaint standing in the one
place it is hardest to read around, because `bridge/pack/` and `docs/crew.md` are the same feature
and nothing at either end says so.

**The constraint is the roll, not the rename.** A crew is updated lead first, and a member has to
answer its lead through the whole of an update, which is exactly the moment two builds are
guaranteed to differ. ADR 0038 read that as a reason not to move the wire. It is a reason to move
the wire *with one release of overlap*: the lead can answer both prefixes for one release, and the
member can dial the new one and fall back once. That is a bounded amount of code with a removal
release, which is what ADR 0012's landing rule asks of a frozen surface. A frozen surface moves with
its own ADR and a stated removal release. This is that ADR, and 1.9.0 is that release.

**1.8.0 is the release because M26 is already in it.** The changelog entry is risk-first either way,
and one release that renames the machine names is cheaper for an operator to read than two that each
rename half.

## Decision

**Every name a machine reads says crew. The word an operator reads does not change at all.**

**The wire moves to protocol version 2.** Paths become `/crew/v1/*`, headers become `X-Crew-*`,
error codes and JSON field names say crew, and `PACK_PROTOCOL_VERSION = 1` becomes
`CREW_PROTOCOL_VERSION = 2`. The `v1` in the path is a path segment and does not move; the version
travels where it always did, in `hello`'s `protocol` field and in the header. `PACK_PROTOCOL.md`
becomes [`CREW_PROTOCOL.md`](../CREW_PROTOCOL.md), and its new §0 states the version and the
overlap.

**One release of overlap, both halves marked and both removed in 1.9.0.** A 1.8.0 lead answers
`/pack/v1/*` in the version 1 shapes, so a 1.7.0 member follows the roll over the link it already
has. A 1.8.0 member dials `/crew/v1/*` first, falls back to `/pack/v1/*` once against a lead that is
still 1.7.0, and logs one line saying it did. Each half carries a `REMOVE_IN_1_9_0` marker and a
test fails at package minor 9, the same pattern as the major-2 test in `cli/program.test.ts`.

**The two environment keys become `COLLIE_CREW_TIMEOUT_MS` and `COLLIE_CREW_HELLO_TIMEOUT_MS`.** The
old key is read while the new one is absent, and one warning line is logged at start. Removed in
1.9.0.

**The three state files become `crew-trust.json`, `crew-ops.json` and `crew-runtime.json`.** On the
first start, each old file is renamed to the new name if the new name does not exist. No `.bak` is
kept, because the update flow already keeps the previous checkout. Keys inside those files that say
pack move with them, with the same one-time read of the old key.

**The journal prefix becomes `[crew]` and the audit field becomes `via: "crew"`.**
[`docs/crew.md`](../docs/crew.md) tells an operator to grep for both prefixes on a journal that spans
the update.

**`/api/crew` replaces `/api/pack`**, which answers 308 to it for one release. The web app calls
`/api/crew`.

**Every identifier moves, as a git move so history follows the file.** `bridge/pack/` becomes
`bridge/crew/`, `cli/pack.ts` becomes `cli/crew.ts`, `web/src/routes/pack.tsx` becomes `crew.tsx`,
`PackRoute` becomes `CrewRoute`, the `pack.*` i18n keys become `crew.*` in all seven locales with
their values untouched, `scripts/check-pack-wire.sh` becomes `check-crew-wire.sh` with its file list
moved, and `scripts/pack-mux-probe.ts` becomes `crew-mux-probe.ts`. Tests and test names follow.

**Three operator-facing aliases are not part of this.** `collie pack`, `collie docs pack` and the
web app's `/pack` redirect stay until 2.0.0 exactly as ADR 0038 wrote them. They are typed by a
person, they are cheap, and they are not what this decision is about.

## Consequences

- **One release runs two listeners.** A 1.8.0 lead serves `/pack/v1/*` and `/crew/v1/*` at once, and
  a 1.8.0 member holds a fallback dial it will use at most once per request. That is the price of
  moving a frozen surface, it is bounded by the marker and the minor-9 test, and it is the reason
  this is one release and not a standing compatibility layer.
- **State migrates itself, once, and nothing is kept behind.** An operator does nothing. A rollback
  to 1.7.0 after that first start does not find the old filenames, and the remedy is the same
  rollback remedy as always: the previous checkout, which the update flow keeps.
- **1.9.0 is a real removal, and it is written down here.** From 1.9.0 the old prefix, the fallback
  and the old environment keys are gone, so a member older than 1.8.0 stops talking to a lead newer
  than 1.8.0. That is §7's exact window doing its usual job rather than a new kind of break.
- **An operator on 1.7.0 updates the lead first.** That is already the order the phone and
  `collie crew update` take. It now carries the compatibility as well: the lead is the side that
  answers the old prefix, so a lead updated first keeps every 1.7.0 member following it. Updating a
  member first is survivable through the fallback and it is not the order to plan.
- **A grep for "pack" now answers one question.** What is left is history: the changelog, the old
  ADRs, `PACK_DEPUTY_RFC.md`, the three aliases, and the marked overlap. None of them is drift.
- **The wire guard's evidence changes shape.** ADR 0025's guard fires on the new file list, and the
  byte-identical-diff evidence ADR 0038 leaned on is spent: this release deliberately changes those
  files. The evidence is the VM lab roll instead, a 1.8.0 lead over two 1.7.0 members, and the
  reverse skew once.

### What would justify revisiting

- **The overlap outliving 1.9.0.** If the fallback is still needed when 1.9.0 is cut, the wrong
  thing was the one-release window, not the rename, and the window is what gets a new ADR.
- **A rename that reaches a person again.** Nothing here touches operator vocabulary. A proposal
  that moves *crew*, the roles or the verbs re-opens ADR 0038 and ADR 0012, not this one.

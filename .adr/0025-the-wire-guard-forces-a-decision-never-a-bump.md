# 0025 — The pack-wire guard forces a decision, never a bump

Status: **Accepted** (2026-08-20)

Protocol: [`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md) §7, §7.1 · Code:
[`scripts/check-pack-wire.sh`](../scripts/check-pack-wire.sh),
[`scripts/git-hooks/pre-commit`](../scripts/git-hooks/pre-commit),
[`bridge/pack/enrollment.ts`](../bridge/pack/enrollment.ts) (`PACK_PROTOCOL_VERSION`) ·
Related: [ADR 0011](./0011-the-pack-protocol-is-the-mux-driver-seam.md)

## Context

`X-Pack-Protocol` is the only thing on a pack link that refuses (§7.1). Build-version skew refuses
nothing, and that is safe **only** because of one obligation: every addition inside a protocol
version is additive-optional with absent-means-closed semantics. Break that obligation once — a
field that changes meaning, a route that stops answering, a gate that tightens — and every older
member in the pack starts getting wrong answers instead of closed ones. There is no runtime signal
for it. The peer does not know it is being lied to; it reads `1`, sees `1`, and proceeds.

So the obligation is enforced by attention, and attention is exactly what a rushed diff spends
first. The failure mode is not someone deciding wrongly. It is someone editing `router.ts` to add a
field, never once framing it as a protocol question, and shipping it — the question was never asked,
so no answer was recorded, and the next person cannot tell whether the omission was a judgement or
an oversight.

The obvious automation does not work. A guard that fails when the pack code changed **and** the
protocol number did not would fire on every legal additive change — which is nearly all of them, the
bump being the rare case — and a guard that cries wolf on the common path is disabled within a week.
Equally, the guard cannot decide which kind of change a diff is: that judgement needs the semantics
of the field, which no script has.

What a script *can* do is refuse a wire-shape commit that recorded **neither** decision.

## Decision

**A staged change to the pack wire surface must carry a recorded protocol decision. The guard checks
that one was recorded; it never says which one is right.**

- **Trigger set**: the nine wire-shape files (`admission`, `enrollment`, `router`, `peer-client`,
  `forward`, `merge`, `peer-gate`, `signing`, `tags`), plus **any newly added non-test
  `bridge/pack/*.ts` file** so a new wire file cannot slip past a fixed list. `*.test.ts` never
  triggers. Internal-logic files (`registry`, `lead`, `mode`, `config`, `identity`, `trust-store`,
  `ops-store`, `transport`, `notify`, `staleness`) are out of scope — a change there is invisible to
  the other end. **The list lives once**, in `check-pack-wire.sh`, with the qualifying rule at it.
- **Two pass conditions, either one**: `PACK_PROTOCOL.md` is staged in the same commit (the contract
  doc records the change), **or** the staged blob of `enrollment.ts` changes the value of
  `PACK_PROTOCOL_VERSION` against `HEAD`.
- **The failure message teaches the three exits** — additive-optional (document it, quoting §7.1's
  absent-means-closed obligation), not-expressible-that-way (bump the integer and spec the version),
  or pure refactor (`SKIP_PACK_WIRE_CHECK=1`).
- **Guard C on the pre-commit hook**, independent of the version and lint guards and skipped by its
  own name. Standalone runs read the staged diff themselves.

## Consequences

- **The common path stays cheap**: an additive-optional change passes by doing the thing it was
  already obliged to do — writing the field into the spec. The guard costs nothing when the work was
  done right.
- **The hatch is the honest exit, and it is meant to be used.** Refactors inside `bridge/pack/` are
  routine and move no bytes. `SKIP_PACK_WIRE_CHECK=1` is a claim on the record in the shell history,
  not a defeat.
- **False negatives remain.** A wire change with a *wrong* PACK_PROTOCOL.md edit passes, and so does
  a semantic break dressed as a doc update. The guard buys a forced question, not a proof — review
  still owns the answer.
- **Why not auto-detect the wire shape** (hash the serialized request/response types and fail on
  drift)? There is no machine-readable schema — the wire is hand-written TypeScript and prose in
  PACK_PROTOCOL.md — so the hash would track refactors, not bytes.
- **Why not fail when the protocol number is unchanged?** It contradicts §7.1: additive-optional
  changes are *supposed* to ship inside a version. Such a guard would push people to bump for safety,
  and a spurious bump is a pack-wide outage (§7's exact-window refusal), which is strictly worse than
  the problem.
- **Why not CI-only?** The decision belongs at the moment the author still has the semantics in
  their head — the same argument the version guard already won. CI would raise it after the framing
  was lost.
- **What would justify revisiting this:** a generated wire schema (an OpenAPI or zod source of truth
  for `/pack/v1/*`). Then the trigger can be the schema diff instead of a file list, and the list —
  and its drift — goes away.

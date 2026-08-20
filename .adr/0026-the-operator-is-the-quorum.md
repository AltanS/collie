# 0026 — The operator is the quorum

Status: **Accepted** (2026-08-20)

Generalises: [ADR 0014](./0014-promote-is-a-confirm-on-the-lead.md) — promotion-is-a-confirm becomes
the no-deputy instance of a broader rule. 0014 is not superseded and its gate is unchanged.
Related: [ADR 0013](./0013-a-peer-listens-without-becoming-a-front-door.md) ·
[ADR 0012](./0012-every-machine-runs-a-collie-and-the-pack-has-a-lead.md) · contract:
[`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md) §18 (the deputy, the warrant, the deposed state, the standby
door and the takeover) · design history: [`PACK_DEPUTY_RFC.md`](../PACK_DEPUTY_RFC.md).

Subordinate: [ADR 0027](./0027-the-deputy-is-named-ahead-of-time.md) (the deputy and its warrant) and
[ADR 0028](./0028-the-standby-door-is-a-second-listener.md) (the standby door).

## Context

A pack has one lead and it is a single point of failure by design (RFC §14, §15). Every proposal to
soften that lands on the same rock, and the rock is not implementation difficulty — it is
information. **A machine cannot distinguish "the lead is dead" from "I cannot reach the lead."**
Silence is identical in both cases, and the two demand opposite responses: take over, or do nothing.

At three or more always-on machines, distributed systems answer this with a quorum: a majority that
can see each other is the partition that gets to act. Collie cannot use that answer, for a reason
that is a fact about its deployments rather than a preference. **A pack is frequently two machines**
(ADR 0014 says so in as many words), and often those two are a desktop and a NAS on the same switch —
the exact topology where a majority does not exist and where the two "sides" of a partition are one
machine each. A quorum scheme at N=2 is a coin flip with ceremony.

There is, however, always a third party with a complete view, and it is the one the whole product is
built around: **the operator, holding a phone, who can see that their lead is not answering and knows
whether they are on hotel wifi.** They are not a fast tie-breaker and they are not always awake. They
are the only one that is *correct*.

Three proposals recur, and each is a different way of trying to route around this, so the decision
has to close all three at once rather than one at a time.

## Decision

**The operator is the quorum. Every leadership transition in a pack is authorised by a human decision
or by a proof the outgoing lead signed — never by a timer, a majority, or an inference from
silence.**

Three doors close, and the reasoning for each is different:

1. **No leader election, and no auto-promotion on a timer.** Nothing promotes itself. Silence may
   *arm* a surface — make an action available to the operator — but it may never *authorise* one. The
   distinction is load-bearing across this whole architecture: arming is reversible, grants nothing,
   and is safe to trigger on a fact an attacker can manufacture; authorising is neither. This also
   closes a security shape ADR 0014 already refused in a narrower form: **a fallback an attacker can
   cause is a fallback an attacker controls.** Anything that promotes on lead-unreachability hands the
   choice of the new lead to whoever can take the old one offline.

2. **At most one standing warrant.** A pack may pre-designate exactly one machine as eligible to be
   taken over to. Ranking deputies — a first choice, a second, a third — is split-brain one level
   down: two armed machines on opposite sides of a partition, each correct about its own silence, each
   with a rule that says it is next. One candidate means there is nothing to rank and no race to
   observe.

3. **No automatic transition without a pre-signed consent chain.** Every state change a machine makes
   about leadership *without an operator present* must be justified by a proof **the old lead itself
   signed** — its own certificate's key, verified against material already pinned before the event.
   This covers self-demotion on an approved promotion, deposition at the boot gate, and a deposed
   lead's self-heal back to peer. A machine may act on its own past consent; it may not act on a
   conclusion it drew. Where no such proof exists, the transition waits for a human, and the machine
   says so rather than guessing.

The corollary that makes rule 3 tolerable rather than paralysing: **an automatic transition that is
strictly privilege-decreasing, justified by such a proof, and creating no trust that did not already
exist, is permitted and is preferred to an operator step.** Demanding a keyboard for a machine
demoting itself buys no safety and costs an outage of that machine's agents.

## Consequences

- **Recovery is bounded by the operator's availability, and that is the trade, stated once.** A pack
  whose lead dies while nobody is looking stays down until somebody looks. Collie's answer is to make
  that look cheap — a phone, a page, one button (ADR 0028) — not to remove the human.
- **A two-machine pack is fully supported and has no witness.** Its takeover rests on the operator's
  own judgement, and the surface says so at the point of decision instead of implying a check it
  cannot perform.
- **Peers may be asked what they observed; they are never asked what should happen.** A peer answering
  "my lead called me two seconds ago" is reporting a fact about its own inbox, and one such answer is
  decisive against a takeover. That is evidence, not a vote — no peer's agreement is required for a
  takeover, only the absence of a contradiction from those that answer.
- **Every leadership object is signed by the lead, not attested by the claimant.** Warrants, handover
  approvals and demotions all verify against material pinned before the event, so a compromised
  claimant gains nothing by asserting more loudly.
- **The pack link never carries a control instruction.** Restarts and code ride the operator's own SSH
  (ADR 0015, ADR 0016) and beacons stay hints (ADR 0024). This ADR is the reason those three hold
  together rather than being three separate preferences.
- **Nothing here is a performance decision, so nothing here is negotiable for speed.** A faster
  failover that infers is a slower incident with a worse cause.

### Alternatives considered

- **Raft / Paxos / any quorum protocol.** Rejected: needs three always-on voters, which the
  deployments do not have. It would also put a distributed-agreement failure mode inside an operator
  verb whose entire design is "a deliberate operator action, not an election" (RFC §14, ADR 0014).
- **A cheap majority over the peers themselves.** Rejected for the same reason plus a worse one: peers
  are frequently laptops that sleep. A quorum whose members are asleep is a quorum that produces a
  wrong answer confidently.
- **A cloud witness / third-party arbiter.** Rejected: it is a dependency on someone else's uptime for
  the recovery path of a self-hosted tool, and it is an outbound path on a host whose whole security
  posture is "publish nothing" (ADR 0001, ADR 0013).
- **Auto-promote after a long timer (an hour, a day).** Rejected: the timer's length does not change
  the epistemics, only the blast radius of being wrong. An attacker who can sustain a partition for
  five minutes can sustain one for a day.
- **Let the operator opt in to auto-promotion.** Rejected for now, and it is the most sympathetic of
  the five: it puts the choice where this ADR says choices belong. But the failure it enables — two
  leads, two rosters, two front doors, divergent agent state — is one the operator cannot detect from
  the phone and cannot easily undo, and an opt-in to an undetectable failure is not informed consent.
  It becomes reasonable the moment a third voter exists, which is the reopening condition below.

### What would justify revisiting

- **A third, always-on machine as a standing member of the pack** — not a laptop, not a phone: a
  machine whose availability is comparable to the lead's. That is the precondition every rejected
  alternative above was missing, and with it a real quorum becomes both possible and cheap, and
  "opt-in auto-promotion" becomes a rule with evidence behind it rather than a timer.
- **Collie growing a real identity model** — the same trigger ADR 0013 and ADR 0014 both name. Once a
  request carries a *person* rather than a machine credential, "the operator consented" can be a
  property of a request rather than a place someone stood, and the shape of this decision changes even
  though its conclusion may not.
- **Evidence that operators are routinely running packs of four or more with distinct operators per
  machine.** Single-operator consent is the model here; a multi-operator pack is a different question.

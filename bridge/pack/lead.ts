import type { JsonValue } from "../json.ts";
import type { SnapshotResponse } from "../types.ts";
import { forwardToPeer, type ForwardDeps, type ForwardTransport } from "./forward.ts";
import { mergeSnapshot, parsePeerSnapshot, type PeerContribution, type PeerSnapshotBody } from "./merge.ts";
import { sweepPeers, type PackLink, type PeerOutcome } from "./peer-client.ts";
import type { HostResolution, HostSelector, PackRegistry, PeerState } from "./registry.ts";
import { PAIRING_LABEL_COLLISION } from "./router.ts";
import {
  pairingPushNeeded,
  parseCollisionReport,
  parsePairingReport,
  type PairingSync,
} from "./standby-devices.ts";
import type { Warrant } from "./trust-store.ts";
import { parseWarrantReport, warrantPushNeeded, type WarrantPush } from "./warrant.ts";

// The lead's side of the pack, assembled: sweep the peers, remember the last-good body, merge.
//
// ── NO SECOND TIMER. NOT ONE. ────────────────────────────────────────────────
// PACK_PROTOCOL.md §10.1: "the peer sweep is a *part of* the existing poll, not a second timer", and
// §11 lists "no second timer, no peer sweep" as a row of the solo contract. So this class arms
// nothing: it exposes {@link PackLead.sweep}, and `bridge/index.ts` calls it from the primary
// session's poll tick (`StateEngine.onTick`). Search this file for `setInterval`/`setTimeout` — the
// absence is the feature, and `lead.test.ts` pins it by asserting a constructed lead makes no call
// until something calls `sweep()`.
//
// The one thing that IS stateful here is what the registry cannot hold: the last-good BODY. Health
// (`reachable`/`lastSeenAt`/reason) lives in `PackRegistry` and only there, so there is still exactly
// one owner of "what the lead believes about peer X"; this class adds "and here is the last thing it
// said", which is what makes §10.2's *a peer's sessions never vanish* mechanical rather than
// aspirational.

/**
 * How long the lead waits before re-probing a member whose protocol it cannot speak (§10.2:
 * "no (probed on a slow backoff)"). The last entry repeats forever — the `bridge/event-poker.ts`
 * backoff convention.
 *
 * **Why a version skew is not retried on the cadence:** it cannot resolve on its own. A peer speaks
 * a different protocol until somebody updates a build, which is minutes-to-days away, so polling it
 * at 1.5 s would be N pointless round trips per second for an outcome that is already known and
 * already rendered. Unreachable is the opposite — a cable, a sleep, a restart — and stays on the
 * cadence.
 */
export const INCOMPATIBLE_BACKOFF_MS: readonly number[] = [30_000, 120_000, 600_000];

/** The delay before the `n`-th consecutive incompatible verdict is re-probed (0-based, clamped). */
export function incompatibleBackoffMs(consecutive: number): number {
  const idx = Math.min(Math.max(consecutive, 1), INCOMPATIBLE_BACKOFF_MS.length) - 1;
  return INCOMPATIBLE_BACKOFF_MS[idx]!;
}

/** What the lead remembers about one peer beyond its health. Pure data; the fold below owns it. */
export interface PeerMemory {
  /** The most recent body that parsed. **Never cleared by a failure** — §10.2's stale-never-vanish. */
  readonly body: PeerSnapshotBody | null;
  /** Consecutive `incompatible` verdicts; 0 whenever the last call was anything else. */
  readonly incompatibleRuns: number;
  /** Epoch ms before which an incompatible member is not dialled again. 0 ⇒ dial now. */
  readonly probeAfter: number;
}

const FRESH: PeerMemory = { body: null, incompatibleRuns: 0, probeAfter: 0 };

/** No member is owed the proof — every lead that never took over, which is almost all of them. */
const EMPTY_PENDING: ReadonlySet<string> = new Set<string>();

/**
 * Fold one call's outcome into what the lead remembers. **Pure** — the whole point, so the three
 * states of §10.2 are unit-testable as data.
 *
 * - success with a parseable body → the body is replaced, backoff cleared.
 * - success with a body that will not parse → the OLD body is kept. A peer that answered 200 with
 *   nonsense has not told us its panes are gone, and inventing "gone" from a parse failure would
 *   empty the phone's triage list on a bad deploy.
 * - unreachable → nothing changes but the clock the registry already stamped. Body kept.
 * - incompatible → body kept, backoff advanced.
 */
export function foldPeerMemory(
  prev: PeerMemory | undefined,
  outcome: PeerOutcome<unknown>,
  now: number,
): PeerMemory {
  const base = prev ?? FRESH;
  if (outcome.ok) {
    // SAFETY: `value` is a peer's HTTP body after `res.json()` — a JsonValue by construction. The
    // type argument stays `unknown` because a caller may script any outcome; `parsePeerSnapshot`
    // re-checks every field of it before a byte is used, so nothing downstream trusts this cast.
    const parsed = parsePeerSnapshot(outcome.value as JsonValue);
    return { body: parsed ?? base.body, incompatibleRuns: 0, probeAfter: 0 };
  }
  if (outcome.state === "incompatible") {
    const runs = base.incompatibleRuns + 1;
    return { body: base.body, incompatibleRuns: runs, probeAfter: now + incompatibleBackoffMs(runs) };
  }
  return { ...base, incompatibleRuns: 0, probeAfter: 0 };
}

/** Whether this member is dialled on this tick. Only an incompatible one is ever skipped. */
export function dueForProbe(memory: PeerMemory | undefined, now: number): boolean {
  return memory === undefined || now >= memory.probeAfter;
}

export interface PackLeadDeps {
  readonly registry: PackRegistry;
  /** `(link) => the peer's /pack/v1/snapshot outcome`. Injected so the sweep is testable without TLS. */
  readonly snapshot: (link: PackLink) => Promise<PeerOutcome<unknown>>;
  /**
   * `PeerClient.proxy`, for the per-pane forward (M4/05). Injected for the same reason `snapshot` is
   * — the routes must be exercisable without a socket — and typed as the pass-through variant, so a
   * peer's own status codes reach the phone intact (§9.1).
   */
  readonly proxy: ForwardTransport;
  /**
   * `PeerClient.hello` — the VERDICT probe (§10.4), on the patient budget.
   *
   * Injected and optional for the same reason `snapshot` is injected: the decision logic must be
   * exercisable without a socket, and a lead built without one simply keeps the pre-2026-08-18
   * behaviour (a timed-out sweep is the whole verdict). Every production wiring supplies it.
   */
  readonly hello?: (link: PackLink) => Promise<PeerOutcome<{ readonly version: string | null }>>;
  /** This collie's member id and label — the `servers[0]` entry (§9.2). */
  readonly self: { readonly id: string; readonly name: string };
  /**
   * Called with a body **that just parsed on this sweep** — never with a retained last-good one.
   * That distinction is the whole contract: `PeerNotifier` derives transitions by diffing successive
   * bodies, so re-offering the retained body of an unreachable peer would make a peer going down
   * look like "nothing changed" forever (harmless) and a peer coming back look like a fresh round of
   * transitions (not harmless — it would re-buzz the phone about hour-old blocks).
   */
  readonly onPeerSnapshot?: (memberId: string, body: PeerSnapshotBody) => void;
  /** Called for a member the registry has dropped (`leave`/revocation/rotation) — see PeerNotifier.forget. */
  readonly onPeerGone?: (memberId: string) => void;
  /**
   * A member answered §18.10's named `lead_conflict`: **it follows somebody else now.**
   *
   * This is the fast path of §18.12's delivery — best-effort and time-boxed, because it only works
   * while this lead is still in that member's TLS anchor list, i.e. until that member's next restart.
   * The boot gate is the reliable path and this must never be built on instead of it.
   *
   * The warrant is handed over unverified: verifying it is the receiver's job and it verifies against
   * its OWN certificate (`deposed.ts`), so nothing in the sweep decides anything about trust.
   */
  readonly onLeadConflict?: (memberId: string, warrant: Warrant | null) => void;
  /**
   * Warrant distribution (§18). Absent ⇒ this lead distributes none, which is every lead that has
   * never named a deputy and every test that is not about warrants.
   */
  readonly warrant?: WarrantDistribution;
  /**
   * Pairing-registry distribution to the DEPUTY (RFC §6.5). Absent ⇒ this lead syncs none, which is
   * every lead that has never named a deputy and every test that is not about the standby door.
   */
  readonly pairing?: PairingDistribution;
  readonly now?: () => number;
}

/**
 * The lead's half of RFC §6.5: keep the DEPUTY's copy of the paired-device registry current.
 *
 * **No second timer and no dial to decide.** The lead already knows when its own registry changed —
 * the store caches on mtime — so the decision is a digest comparison against what this process last
 * delivered, and only a genuine change costs a dial. It rides the sweep for the reason everything
 * else does (§10.1, §11).
 */
export interface PairingDistribution {
  /** The deputy this lead has designated, or `null`. Read through the store, never captured. */
  deputy(): string | null;
  /**
   * What would be sent right now, with a digest over the SENT projection. `null` ⇒ nothing to send
   * (no pack, or a registry this lead cannot read). An EMPTY device list is still something to send:
   * a revocation on the lead has to reach the deputy, or a door stays armed on a dead credential.
   */
  current(): { readonly sync: PairingSync; readonly digest: string } | null;
  /** Deliver it. Failure is a value here as everywhere else in the pack client. */
  push(link: PackLink, sync: PairingSync): Promise<PeerOutcome<unknown>>;
  /**
   * What the last delivered sync came to: the labels the deputy refused on (§18.14), or `null` for
   * "it landed". Optional, and a lead that wires none simply reports none.
   *
   * Only the two *decided* outcomes are reported. A sync that could not be delivered at all says
   * nothing here on purpose: an unreachable deputy is already rendered as unreachable, and a
   * collision finding raised by silence would be a fact this lead never learned.
   */
  collision?(labels: readonly string[] | null): void;
}

/**
 * The two things the sweep needs in order to keep every member's warrant current, injected for the
 * reason `snapshot` and `hello` are: the decision logic must be exercisable without a socket or a
 * disk.
 */
export interface WarrantDistribution {
  /**
   * The warrant this lead currently issues, **re-signed first when the refresh interval has elapsed**
   * (RFC §4.5), with the deputy's certificate beside it. `null` when no deputy has been named.
   *
   * Awaited on the tick, and that is deliberate: it is a local read that writes at most once an hour,
   * never a dial, so it costs the poll's budget nothing. The dial is {@link WarrantDistribution.push}
   * and that one is never awaited.
   */
  current(now: number): Promise<WarrantPush | null>;
  /** Deliver it to one member. Failure is a value here as everywhere else in the pack client. */
  push(link: PackLink, payload: WarrantPush): Promise<PeerOutcome<unknown>>;
  /**
   * Members this lead took over from that have **not yet been told** (RFC §7.1's partial success,
   * §9's reconciliation). Read through the store each sweep, never captured.
   *
   * They are the one class of member that is pushed to even when they did NOT answer the sweep — the
   * ordinary rule is "a member that said nothing is skipped", and the ordinary rule is right, but a
   * pending member has told us something already: it is behind, and the push IS how it finds out. It
   * is also the only way to reach a machine that still believes it leads, whose listener answers
   * nothing else this lead can authenticate to.
   */
  pending?(): ReadonlySet<string>;
  /** A pending member took the proof. Clears its flag, so this costs one round trip once, ever. */
  confirm?(memberId: string): Promise<void>;
}

/**
 * The lead runtime. Built only when this collie is in `lead` mode (≥1 enrolled peer, no lead of its
 * own — `bridge/pack/mode.ts`), so an instance with a trust store but nobody enrolled builds none and
 * keeps emitting a solo body: `servers` present ⇔ a pack with peers exists.
 */
export class PackLead {
  private readonly memory = new Map<string, PeerMemory>();
  private readonly now: () => number;
  private sweeping = false;
  /** Members with a verdict probe in flight. At most one per member, ever — see {@link probe}. */
  private readonly probing = new Set<string>();
  /** Members with a warrant push in flight. At most one per member — see {@link pushWarrant}. */
  private readonly pushingWarrant = new Set<string>();
  /** At most one pairing sync in flight. **Nothing about what landed is remembered** — §18.14. */
  private pushingPairing = false;

  constructor(private readonly deps: PackLeadDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * One pass over every peer, concurrently (§10.1: "N peers must not add N round trips of latency"),
   * each bounded by the timeout budget baked into the client.
   *
   * Re-entrancy is refused rather than queued, mirroring `StateEngine.poll`'s own guard: against a
   * slow peer, back-to-back ticks would otherwise stack overlapping sweeps, and the freshest answer
   * is the only one that matters.
   *
   * Never throws. A throw here would surface inside the lead's poll tick, and §10.2's "unreachable is
   * a value, never an error" has to hold at the call site too, not just in the client.
   */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      // A member dropped by `leave`/revocation/rotation stops existing rather than lingering as a
      // stale row — the registry's contract, and its body goes with it.
      for (const id of this.deps.registry.prune()) {
        this.memory.delete(id);
        this.deps.onPeerGone?.(id);
      }

      const now = this.now();
      const due = this.deps.registry.links().filter((l) => dueForProbe(this.memory.get(l.memberId), now));
      if (due.length === 0) return;

      const outcomes = await sweepPeers(due, (link) => this.deps.snapshot(link));
      for (const link of due) {
        const outcome = outcomes.get(link.memberId);
        if (outcome === undefined) continue;
        const memberId = link.memberId;
        this.deps.registry.record(memberId, outcome);
        // A sweep that died on its OWN clock has learned nothing about the machine (§10.4). Re-ask on
        // the patient budget, off this tick — never awaited, so the strict budget still bounds the
        // poll exactly as §10.1 requires. A refusal, a reset or a DNS failure is skipped: those are
        // answers from the world, and re-asking them slowly would only be slower.
        if (!outcome.ok && outcome.state === "unreachable" && outcome.timedOut === true) this.probe(link);
        // §18.10: this member follows somebody else. Handed straight over — a lead that has been
        // deposed stops sweeping, so there is nothing here to back off or remember.
        if (!outcome.ok && outcome.state === "conflicted") {
          this.deps.onLeadConflict?.(memberId, outcome.warrant);
        }
        const previous = this.memory.get(memberId);
        const next = foldPeerMemory(previous, outcome, this.now());
        this.memory.set(memberId, next);
        // Identity, not equality: `parsePeerSnapshot` mints a fresh object on every success and the
        // fold RETAINS the old one on every failure, so `!==` is exactly "this poll produced a body".
        // An unchanged peer still yields a new object each poll — a diff of nothing, which is what
        // makes the notifier's dedupe cheap rather than a second cache to keep honest.
        if (next.body !== null && next.body !== previous?.body) {
          this.deps.onPeerSnapshot?.(memberId, next.body);
        }
      }
      // ── TWO INDEPENDENT DISTRIBUTIONS, TWO INDEPENDENT GUARDS ─────────────
      // They used to share this try, and a live drill showed what that costs: the warrant half awaits
      // a store write (the hourly refresh), so any failure there took the pairing half down with it
      // for every sweep thereafter — silently, since the outer catch logs one line about "the sweep".
      // Neither is the other's precondition, so neither may be the other's single point of failure.
      await this.guarded("warrant distribution", () => this.distributeWarrant(due, outcomes));
      await this.guarded("pairing sync", async () => this.distributePairing(due, outcomes));
    } catch (err) {
      // Defensive: nothing above is supposed to reject. If something does, the pack degrades to
      // "stale" rather than taking the lead's poll loop down with it.
      console.warn(`[pack] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Bring every member that just answered up to the warrant this lead currently issues (§18, RFC §5).
   *
   * **NO NEW TIMER, and no new dial to decide.** The comparison rides the `snapshot` answer this
   * sweep already collected — two optional fields on a body that was fetched anyway — so a pack whose
   * members are current costs exactly nothing here. Only a member genuinely behind is dialled, which
   * makes this three things at once: the peer that was offline when the deputy was named, the peer
   * that has never heard of warrants, and every member once an hour when the signature is refreshed.
   *
   * A member that did NOT answer is skipped rather than pushed to blind: it has told us nothing about
   * what it holds, and a second dial into a dead link is a second failure per tick for no information.
   */
  /** Run one distribution so its failure is its own. Named, so the journal says WHICH half broke. */
  private async guarded(what: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      console.warn(`[pack] ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async distributeWarrant(due: readonly PackLink[], outcomes: Map<string, PeerOutcome<unknown>>): Promise<void> {
    const distribution = this.deps.warrant;
    if (distribution === undefined) return;
    const payload = await distribution.current(this.now());
    if (payload === null) return;
    const pending = distribution.pending?.() ?? EMPTY_PENDING;
    for (const link of due) {
      const outcome = outcomes.get(link.memberId);
      if (outcome === undefined) continue;
      if (!outcome.ok) {
        // RFC §9: a member that has not yet been told the crown moved is pushed to BLIND, because
        // being told is the whole point and because the machine most likely to be in this state — a
        // lead that was deposed while it was down — cannot answer a snapshot to this collie at all.
        if (pending.has(link.memberId)) this.pushWarrant(distribution, link, payload, true);
        continue;
      }
      // SAFETY: `value` is a peer's HTTP body after `res.json()` — a JsonValue by construction, the
      // same cast and the same reason as `foldPeerMemory`'s. `parseWarrantReport` re-checks both
      // fields, and an absent or half-formed pair reads as "unknown", which pushes.
      const reported = parseWarrantReport(outcome.value as JsonValue);
      const reconcile = pending.has(link.memberId);
      // A pending member that ALREADY reports this generation has been told — by its own boot gate,
      // by a `lead_conflict` it answered, or by the commit round of the takeover itself. Pushing the
      // proof again would be refused as `foreign` (its lead is this collie now, and the warrant was
      // signed by the previous one), so the flag would never clear and the dial would repeat every
      // sweep forever. Reading the answer that is already in hand is the whole of §9's "and never
      // again".
      if (reconcile && reported !== null && reported.generation >= payload.warrant.generation) {
        void distribution.confirm?.(link.memberId);
        continue;
      }
      if (!reconcile && !warrantPushNeeded(payload.warrant, reported)) continue;
      this.pushWarrant(distribution, link, payload, reconcile);
    }
  }

  /**
   * Keep the deputy's copy of the paired-device registry current (RFC §6.5).
   *
   * **To the deputy and to nobody else**, and only when what would be sent differs from what this
   * process last delivered. Off the tick and never awaited, exactly as the warrant push is, so a
   * sweep still costs one strict budget (§10.1).
   */
  private distributePairing(due: readonly PackLink[], outcomes: Map<string, PeerOutcome<unknown>>): void {
    const distribution = this.deps.pairing;
    if (distribution === undefined || this.pushingPairing) return;
    const deputy = distribution.deputy();
    if (deputy === null) return;
    const link = due.find((l) => l.memberId === deputy);
    const outcome = outcomes.get(deputy);
    if (link === undefined || outcome === undefined || !outcome.ok) return;
    const payload = distribution.current();
    if (payload === null) return;
    // THE DEPUTY'S OWN ANSWER decides this, not something this process remembers (§18.14).
    // SAFETY: `value` is that member's HTTP body after `res.json()` — a JsonValue by construction, the
    // same cast and the same reason as `foldPeerMemory`'s. `parsePairingReport` re-checks it, and
    // anything that is not a digest reads as "nothing synced", which pushes.
    const reported = parsePairingReport(outcome.value as JsonValue);
    // §18.14's finding, read off the SAME answer and on EVERY sweep — never off the push, which only
    // happens when the two copies differ. That is what makes it visible while true and gone when
    // fixed; carrying it on the push made it flicker for one sweep and then vanish.
    // SAFETY: `value` is that member's HTTP body after `res.json()` — a JsonValue by construction,
    // the same cast and the same reason as `parsePairingReport`'s above; `parseCollisionReport`
    // re-checks every element before any of it reaches a surface.
    distribution.collision?.(parseCollisionReport(outcome.value as JsonValue));
    if (!pairingPushNeeded(payload.digest, reported)) return;
    this.pushingPairing = true;
    void (async () => {
      try {
        const pushed = await distribution.push(link, payload.sync);
        // Nothing is remembered here on purpose — the next sweep re-reads the deputy's own report, so
        // a push that half-landed, a process that restarted and a registry that changed underneath all
        // converge without this class holding an opinion. A refused sync (a label collision, RFC §16
        // decision 6) is simply re-offered, which is what makes the operator's rename take effect
        // without a restart.
        if (!pushed.ok && pushed.state === "refused" && pushed.code === PAIRING_LABEL_COLLISION) {
          // A PRE-AMENDMENT deputy, which REFUSED the sync outright instead of applying it and
          // reporting. Read so the operator still sees the finding — but that build's copy is frozen
          // until it is updated, and a frozen copy is a revoked credential still live at its door.
          // This lead cannot close that from here; naming it is all it can do.
          distribution.collision?.(pushed.labels ?? []);
        }
      } catch (err) {
        console.warn(`[pack] pairing sync failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.pushingPairing = false;
      }
    })();
  }

  /**
   * Deliver one warrant, off the tick and never awaited — the same discipline {@link probe} follows,
   * for the same reason: a sweep must cost one strict budget no matter what else it decided to do.
   *
   * At most one push per member is in flight. A push that lands after the member has been pruned is
   * simply a failed dial; nothing here writes to this lead's store, so a `leave` mid-flight cannot be
   * undone by it.
   */
  private pushWarrant(
    distribution: WarrantDistribution,
    link: PackLink,
    payload: WarrantPush,
    reconcile = false,
  ): void {
    if (this.pushingWarrant.has(link.memberId)) return;
    this.pushingWarrant.add(link.memberId);
    void this.runWarrantPush(distribution, link, payload, reconcile);
  }

  /** The push's body. Separate so {@link pushWarrant} can start it without awaiting it. */
  private async runWarrantPush(
    distribution: WarrantDistribution,
    link: PackLink,
    payload: WarrantPush,
    reconcile: boolean,
  ): Promise<void> {
    try {
      const outcome = await distribution.push(link, payload);
      // The member took the proof: it either re-pinned to this collie or deposed itself to a peer of
      // it, and either way it never needs telling again. Clearing the flag is what makes §9's "one
      // extra round trip, once per member, and never again" true rather than aspirational.
      if (reconcile && outcome.ok) await distribution.confirm?.(link.memberId);
    } catch (err) {
      // Defensive, exactly as `sweep` and `probe` are: failure is a value everywhere in the pack
      // client, so a throw here is a bug in an injected transport — and it must not become an
      // unhandled rejection that takes the bridge down.
      console.warn(`[pack] warrant push failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.pushingWarrant.delete(link.memberId);
    }
  }

  /**
   * Ask one member the verdict question, patiently, off the poll's hot path (§10.4).
   *
   * **Not a second timer** (§10.1, §11): nothing here arms a clock. The probe is started by a sweep
   * that just timed out and is never awaited by it, so a tick still costs one strict budget. At most
   * one probe per member is in flight — the patient budget outlasts several polls, and stacking one
   * probe per tick would turn a slow peer into a fan-out of dials at exactly the wrong moment.
   *
   * A probe that lands after the member has been pruned is dropped: a `leave` mid-flight must not
   * resurrect a row the registry has already forgotten.
   */
  private probe(link: PackLink): void {
    const hello = this.deps.hello;
    if (hello === undefined || this.probing.has(link.memberId)) return;
    this.probing.add(link.memberId);
    void this.runProbe(hello, link);
  }

  /** The probe's body. Separate so {@link probe} can start it without awaiting it. */
  private async runProbe(
    hello: NonNullable<PackLeadDeps["hello"]>,
    link: PackLink,
  ): Promise<void> {
    try {
      const outcome = await hello(link);
      if (this.deps.registry.links().some((l) => l.memberId === link.memberId)) {
        this.deps.registry.recordProbe(link.memberId, outcome, { version: outcome.ok ? outcome.value.version : null });
      }
    } catch (err) {
      // Defensive, exactly as `sweep` is: failure is a value everywhere in the pack client, so a
      // throw here is a bug in an injected transport — and it must not become an unhandled rejection
      // that takes the bridge down.
      console.warn(`[pack] probe failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.probing.delete(link.memberId);
    }
  }

  /**
   * `(host, session)` resolution for the routes, delegated verbatim to the registry (M4/03) — this
   * class adds nothing, so there is one implementation of "which machine is `?h=` naming" and the
   * rule that a host is only ever a registry key lives in exactly one file.
   */
  resolve(host: HostSelector, session?: string): HostResolution | undefined {
    return this.deps.registry.resolve(host, session);
  }

  /**
   * Forward one session-scoped request to the peer that owns it and answer with what the peer said
   * (§5, §9.1, §10.3). Delegates wholesale to {@link forwardToPeer}, which is pure but for this
   * transport — the class contributes the link and nothing else, so the forwarding rules have one
   * home and it is not a runtime object.
   */
  forward(
    req: Request,
    url: URL,
    resolved: { readonly link: PackLink; readonly state: PeerState },
    opts: { readonly audit?: ForwardDeps["audit"]; readonly device?: string | null } = {},
  ): Promise<Response> {
    return forwardToPeer(req, url, {
      link: resolved.link,
      state: resolved.state,
      transport: this.deps.proxy,
      // Every landed forward refreshes this member's receipt, so a watched peer's freshness tracks
      // the phone's cadence rather than the sweep's idle one. The registry owns the rules (successes
      // only, reachable members only, monotone) — this class just supplies the member id.
      onExchange: (receivedAt) => void this.deps.registry.recordExchange(resolved.link.memberId, receivedAt),
      ...opts,
    });
  }

  /** What {@link mergeSnapshot} consumes: registry health + this class's last-good bodies. */
  contributions(): PeerContribution[] {
    return this.deps.registry.list().map((state) => ({
      state,
      // The member id IS the operator's label, slugified at `join` (§8.2) — the trust store keeps no
      // separate display name, so inventing one here would be inventing a second identity.
      name: state.memberId,
      body: this.memory.get(state.memberId)?.body ?? null,
    }));
  }

  /** Fold the lead's own body into the merged one. The only re-serialisation on a pack link (§9.2). */
  merge(local: SnapshotResponse): SnapshotResponse {
    return mergeSnapshot(local, {
      self: this.deps.self,
      peers: this.contributions(),
      now: this.now(),
    });
  }
}

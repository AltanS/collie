import type { JsonValue } from "../json.ts";
import type { SnapshotView } from "../sessions.ts";
import type { MuxConfig, SnapshotResponse } from "../types.ts";
import { forwardToPeer, type ForwardDeps, type ForwardTransport } from "./forward.ts";
import {
  mergeSnapshot,
  narrowPeerBody,
  parsePeerSnapshot,
  SWEEP_VIEW,
  type PeerContribution,
  type PeerSnapshotBody,
  type SnapshotPlan,
} from "./merge.ts";
import { parsePeerVersion, sweepPeers, type CrewLink, type PeerOutcome } from "./peer-client.ts";
import type { HostResolution, HostSelector, CrewRegistry, PeerState } from "./registry.ts";
import { PAIRING_LABEL_COLLISION } from "./router.ts";
import {
  pairingPushNeeded,
  parseCollisionReport,
  parsePairingReport,
  type PairingSync,
} from "./standby-devices.ts";
import type { Warrant } from "./trust-store.ts";
import { parseWarrantReport, warrantPushNeeded, type WarrantPush } from "./warrant.ts";
import {
  crewUpdateRows,
  parsePeerPreflight,
  parsePeerRun,
  type CrewUpdateRow,
} from "../update-action.ts";
import { UpdateTurns, type PeerLeg, type TurnMember } from "./follow.ts";

// The lead's side of the crew, assembled: sweep the peers, remember the last-good body, merge.
//
// ── NO SECOND TIMER. NOT ONE. ────────────────────────────────────────────────
// CREW_PROTOCOL.md §10.1: "the peer sweep is a *part of* the existing poll, not a second timer", and
// §11 lists "no second timer, no peer sweep" as a row of the solo contract. So this class arms
// nothing: it exposes {@link CrewLead.sweep}, and `bridge/index.ts` calls it from the primary
// session's poll tick (`StateEngine.onTick`). Search this file for `setInterval`/`setTimeout` — the
// absence is the feature, and `lead.test.ts` pins it by asserting a constructed lead makes no call
// until something calls `sweep()`.
//
// The one thing that IS stateful here is what the registry cannot hold: the last-good BODY. Health
// (`reachable`/`lastSeenAt`/reason) lives in `CrewRegistry` and only there, so there is still exactly
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

/**
 * At most one backoff reset per member per this window (M20/02).
 *
 * The reset is triggered by the peer, so without a floor a peer that dials in a loop would keep
 * itself permanently due and turn the ladder into a hot loop this lead pays for. Ten seconds is far
 * longer than the sweep cadence, so the reset always gets its dial, and far shorter than the ladder's
 * first step, so it is still a shortcut.
 */
export const CONTACT_RESET_FLOOR_MS = 10_000;

/**
 * How many resets one member gets before the ladder stands (M20/02).
 *
 * Contact is EVIDENCE that the lead's guess is stale, and five pieces of evidence that never once
 * produced a successful sweep answer is not evidence any more, it is a peer that can reach us and
 * cannot serve us. The ladder is the right answer to that, and the counter is cleared by the one
 * thing that settles the question: an `ok` answer to a real dial.
 */
export const MAX_CONTACT_RESETS = 5;

/**
 * `memory` with its incompatible backoff forgotten — pure, and the only shape a reset may take.
 *
 * `undefined` in, `undefined` out: a member this lead has never folded has no backoff to clear and is
 * already due, so there is nothing here to invent. Every other field is carried through untouched,
 * `body` above all: the last good snapshot is what §10.2 promises a peer's sessions never lose, and a
 * reset is about the SCHEDULE and never about what this lead knows.
 */
export function clearPeerBackoff(memory: PeerMemory | undefined): PeerMemory | undefined {
  if (memory === undefined) return undefined;
  return { ...memory, incompatibleRuns: 0, probeAfter: 0 };
}

/**
 * Whether this member is dialled on this tick. Only an incompatible one is ever skipped, and only
 * while no live run is waiting on it.
 *
 * `urgent` is the run's veto (M20/01): a member with an open leg is dialled every sweep, whatever
 * `probeAfter` holds. It is a SECOND RULE and not a cap, which is the counsel decision of
 * 2026-09-07. A cap would write the run's opinion into the backoff record, and the peer's real
 * backoff would be gone the moment the run touched it. Here the run reads and never writes, so the
 * ladder the peer earned is intact and waiting the moment the run is over.
 */
export function dueForProbe(memory: PeerMemory | undefined, now: number, urgent = false): boolean {
  return urgent || memory === undefined || now >= memory.probeAfter;
}

export interface CrewLeadDeps {
  readonly registry: CrewRegistry;
  /**
   * `cfg.maxUploadBytes` — this lead's own attachment cap, forwarded into every §13 pre-check.
   * Per host, so a member on a different `COLLIE_MAX_UPLOAD_MB` is legal and answers for itself.
   */
  readonly maxUploadBytes: number;
  /**
   * `(link, view) => the peer's /crew/v1/snapshot outcome`. Injected so the sweep is testable
   * without TLS.
   *
   * `view` is how much of that machine to ask for (M22/06). {@link CrewLead.sweep} always passes
   * `SWEEP_VIEW`, so the lead's cache holds every session a member has and the narrowing happens at
   * the merge instead — a view the lead does not already hold cannot be fetched inside a phone poll
   * (§10.1). It is additive and optional on the wire: a member too old to read the parameter answers
   * with its primary session, exactly as before.
   *
   * `freshPreflight` is §19's one header reaching through: the phone's own on-demand read asks every
   * member to re-run its update check on this one dial. It is a REQUEST — a peer that ignores it
   * answers with an older report and an `asOf` that says so — and the periodic sweep never sets it.
   */
  readonly snapshot: (
    link: CrewLink,
    view: SnapshotView,
    freshPreflight?: boolean,
    follow?: { readonly leadRelease?: string | null; readonly turn?: string | null },
  ) => Promise<PeerOutcome<unknown>>;
  /**
   * §20's half of the sweep (M16/04): what this lead may state about ITSELF, and the queue that
   * hands out one turn at a time.
   *
   * Injected and optional, for the reason `hello` is: a lead built without it keeps today's sweep
   * byte for byte, and neither header goes on the wire. Every production wiring supplies it.
   */
  readonly follow?: FollowDistribution;
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
  readonly hello?: (
    link: CrewLink,
  ) => Promise<PeerOutcome<{ readonly version: string | null; readonly mux?: MuxConfig | null }>>;
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
  /**
   * Where a `[crew]` line goes. Defaults to `console.log`, which is the bridge's journal.
   *
   * Injected for the reason `snapshot` is: a test asserts the sentence rather than the side effect,
   * and a suite that exercises a hundred sweeps stays silent. It changes nothing about the sweep —
   * every line below is emitted on a state CHANGE, so a member that keeps saying the same thing
   * costs one line ever, not one per tick.
   */
  readonly log?: (line: string) => void;
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
   * (no crew, or a registry this lead cannot read). An EMPTY device list is still something to send:
   * a revocation on the lead has to reach the deputy, or a door stays armed on a dead credential.
   */
  current(): { readonly sync: PairingSync; readonly digest: string } | null;
  /** Deliver it. Failure is a value here as everywhere else in the crew client. */
  push(link: CrewLink, sync: PairingSync): Promise<PeerOutcome<unknown>>;
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

/** What the sweep needs to state a release and hand out a turn (§20, M16/04). */
export interface FollowDistribution {
  /**
   * This lead's own settled release, or `null` while it may state nothing —
   * `bridge/crew/follow.ts`'s `leadReleaseHeader` over this process's own version and run
   * record. Read on every sweep rather than captured: a lead settles mid-life, and a value taken at
   * boot would keep a whole crew waiting for a restart.
   */
  readonly leadRelease: () => string | null;
  /** The in-memory queue. Never persisted — a lead restart re-derives it and re-grants. */
  readonly turns: UpdateTurns;
  /** `enrolledAt` per member, the trust store's own ordering. Read through the store each sweep. */
  readonly enrolledAt: (memberId: string) => number;
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
  /** Deliver it to one member. Failure is a value here as everywhere else in the crew client. */
  push(link: CrewLink, payload: WarrantPush): Promise<PeerOutcome<unknown>>;
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
 * own — `bridge/crew/mode.ts`), so an instance with a trust store but nobody enrolled builds none and
 * keeps emitting a solo body: `servers` present ⇔ a crew with peers exists.
 */
export class CrewLead {
  private readonly memory = new Map<string, PeerMemory>();
  /**
   * What each member last said its own multiplexer can do (M22/03), for `/api/config?host=<member>`.
   *
   * Beside the peer memory rather than in the registry, for the memory's own reason: the registry
   * owns HEALTH, and this is the other kind of per-member fact, the last thing a member said about
   * itself. A member with no entry is a member that has published nothing, and that reads as **"use
   * the lead's answer"** — exactly the reading the phone gives every pane today.
   *
   * **REPLACED on every successful hello, never merged into.** A restart or an adapter change is a
   * whole new declaration, so folding the new answer into the old one could leave a key alive that
   * the member no longer answers for. A successful hello that carried NO block drops the entry, for
   * the same reason: the member's current answer is "nothing", and "nothing" means the lead's.
   */
  private readonly muxBlocks = new Map<string, MuxConfig>();
  /**
   * Members whose CURRENT link has already answered a hello, so their block is as fresh as the link.
   *
   * The sweep dials `snapshot`, not `hello`, so without this the lead would only ever learn a block
   * from the §10.4 verdict probe, which fires when a sweep times out. That is the wrong moment and
   * for most crews it is never. So a member that answers a sweep while this set does not hold it
   * earns ONE hello, off the tick and un-awaited, exactly as the verdict probe is (no new timer,
   * §10.1). Any failed dial forgets it, so a reconnect re-asks and a stale block is never served
   * past one.
   */
  private readonly muxAsked = new Set<string>();
  /**
   * The state each member's last journal line named. A line is written when this string changes and
   * never otherwise, so the sweep's 1.5 s cadence cannot turn a down peer into a stream.
   */
  private readonly loggedState = new Map<string, string>();
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private sweeping = false;
  /** Members with a verdict probe in flight. At most one per member, ever — see {@link probe}. */
  private readonly probing = new Set<string>();
  /** Members with a warrant push in flight. At most one per member — see {@link pushWarrant}. */
  private readonly pushingWarrant = new Set<string>();
  /** At most one pairing sync in flight. **Nothing about what landed is remembered** — §18.14. */
  private pushingPairing = false;
  /** Per member: when its backoff was last cleared by contact, and how many times running (M20/02). */
  private readonly contactResets = new Map<string, { at: number; count: number }>();
  /**
   * Per member: the dial this lead is currently waiting on. Bumped on EVERY re-dial (M22/05).
   *
   * ── THE FENCE, AND THE FAILURE IT PREVENTS ────────────────────────────────
   * The pattern already exists one level up: {@link CrewLead.sweep} reads `runAtStart` before the
   * dials, because a run that begins while dials are in flight has a roster this sweep never asked
   * about. A LINK deserves the same fence. Two calls about one member can be in flight at once — the
   * sweep's `snapshot` and the verdict `hello` of {@link CrewLead.probe}, which is deliberately not
   * awaited — so a slow answer from an older dial can land after a newer one and overwrite it. The
   * registry would then hold an older world, and the fold would report it as the current one: a peer
   * that is answering reads slow-linked, or a peer that has come back reads away.
   *
   * It is a COUNTER and not a timestamp, because two dials in the same millisecond are ordinary and a
   * clock cannot separate them. Named `dialGeneration` and never `generation`: the warrant already
   * owns that word (`registry.ts`, `warrant.ts`), and these two must never be read as the same thing.
   */
  private readonly dialGenerations = new Map<string, number>();

  constructor(private readonly deps: CrewLeadDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /**
   * Claim the next dial generation for a member, just before it is dialled. Every re-dial bumps.
   */
  private nextDialGeneration(memberId: string): number {
    const next = (this.dialGenerations.get(memberId) ?? 0) + 1;
    this.dialGenerations.set(memberId, next);
    return next;
  }

  /**
   * Whether a reply from `dialGeneration` has been overtaken — i.e. this member was re-dialled while
   * that call was in flight.
   *
   * **The drop is a VALUE, not an error.** Nothing throws, nothing empties a member's rows, and the
   * registry keeps exactly what the newer dial taught it. The line names both numbers, because the
   * gap between them is the fact worth reading in a journal.
   */
  private staleDial(memberId: string, dialGeneration: number, what: string): boolean {
    const current = this.dialGenerations.get(memberId) ?? 0;
    if (dialGeneration >= current) return false;
    this.log(`[crew] ${memberId}: dropped a stale ${what} reply, dial ${dialGeneration} of ${current}`);
    return true;
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
  async sweep(opts: { readonly freshPreflight?: boolean } = {}): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      // A member dropped by `leave`/revocation/rotation stops existing rather than lingering as a
      // stale row — the registry's contract, and its body goes with it.
      for (const id of this.deps.registry.prune()) {
        this.memory.delete(id);
        // A member that left takes its declaration with it, so nothing can answer `?host=` for a
        // machine this lead no longer knows.
        this.muxBlocks.delete(id);
        this.muxAsked.delete(id);
        this.loggedState.delete(id);
        this.contactResets.delete(id);
        this.dialGenerations.delete(id);
        this.deps.onPeerGone?.(id);
      }

      // §20: what this lead may state, computed ONCE per sweep. The turn is per member — at most
      // one member holds it — so it is read inside the loop below. Read before `due`, because the
      // run's open legs are half of what makes a member due.
      const follow = this.deps.follow;
      const now = this.now();
      // The run this sweep is ABOUT, read before the dials. `due` is computed from it and cannot be
      // recomputed halfway: a run that begins while the dials are in flight (the operator's confirm,
      // or the boot-time gate) has a roster this sweep never asked about, and folding it would settle
      // that run on a list of members it has not looked at once. See the guard below the dials.
      const runAtStart = follow?.turns.current()?.runId ?? null;
      const due = this.deps.registry
        .links()
        .filter((l) => dueForProbe(this.memory.get(l.memberId), now, follow?.turns.hasOpenLeg(l.memberId) ?? false));
      // A QUIET SWEEP IS NOT A STILL ONE. Nobody is due, so nobody is dialled — but the fold and the
      // settle check still run, because a leg that has aged past the wall clock can end on the
      // evidence already in hand. Returning before them is what let the drill's run sit open with
      // every fact needed to close it already banked.
      if (due.length === 0) {
        this.foldTurns(follow, [], new Map());
        return;
      }

      const leadRelease = follow?.leadRelease() ?? null;
      // The dial each member is about to make, claimed BEFORE the call and carried beside the answer
      // — the link's `runAtStart`. See {@link CrewLead.dialGenerations}.
      const dialled = new Map(due.map((link) => [link.memberId, this.nextDialGeneration(link.memberId)]));
      const outcomes = await sweepPeers(due, (link) =>
        this.deps.snapshot(link, SWEEP_VIEW, opts.freshPreflight === true, {
          leadRelease,
          turn: follow?.turns.turnFor(link.memberId) ?? null,
        }),
      );
      // Every member whose answer survived the fence. The dropped ones are removed from `outcomes`
      // too, so nothing downstream — the leg fold, the warrant push, the pairing sync — can reach an
      // answer this lead has already decided not to believe.
      const folded: CrewLink[] = [];
      for (const link of due) {
        const outcome = outcomes.get(link.memberId);
        if (outcome === undefined) continue;
        const memberId = link.memberId;
        // THE FENCE. A reply from a dial this lead has already re-made is dropped here, before the
        // registry, before `foldPeerMemory` and before the merge can see it.
        if (this.staleDial(memberId, dialled.get(memberId) ?? 0, "snapshot")) {
          outcomes.delete(memberId);
          continue;
        }
        folded.push(link);
        // §5/§19's version sibling, read off the very answer this sweep already has. An OBSERVATION
        // is passed only when one was actually carried: `parsePeerVersion` answering `null` means
        // this answer said nothing (a peer older than the amendment, or a body without the field),
        // and the registry's absent-observation branch then keeps what `hello` last taught it.
        // Erasing on silence would trade "never learned" for "unlearned once a sweep", which is worse.
        //
        // SAFETY: `value` is a peer's HTTP body after `res.json()` — a JsonValue by construction,
        // the same cast and the same reason as `foldPeerMemory`'s below.
        const seen = outcome.ok ? parsePeerVersion(outcome.value as JsonValue) : null;
        this.deps.registry.record(memberId, outcome, seen === null ? undefined : { version: seen });
        // A sweep that died on its OWN clock has learned nothing about the machine (§10.4). Re-ask on
        // the patient budget, off this tick — never awaited, so the strict budget still bounds the
        // poll exactly as §10.1 requires. A refusal, a reset or a DNS failure is skipped: those are
        // answers from the world, and re-asking them slowly would only be slower.
        if (!outcome.ok && outcome.state === "unreachable" && outcome.timedOut === true) this.probe(link);
        // M22/03: the member answered, so the lead may ask it ONCE what its multiplexer can do. It
        // goes through the same seam the verdict probe uses, so it arms no timer (§10.1) and at most
        // one hello per member is ever in flight. Any other outcome forgets the answer instead, so
        // the next return re-asks rather than serving a block from before the link dropped.
        if (outcome.ok) this.learnCapabilities(link);
        else this.muxAsked.delete(memberId);
        // §18.10: this member follows somebody else. Handed straight over — a lead that has been
        // deposed stops sweeping, so there is nothing here to back off or remember.
        if (!outcome.ok && outcome.state === "conflicted") {
          this.deps.onLeadConflict?.(memberId, outcome.warrant);
        }
        // §19: what that member says about its OWN checkout, banked beside its version. Only off a
        // successful answer, and never re-fetched on a read — the card composes from this bank, and
        // `status-wire.ts`'s purity argument is why (a surface the phone polls must not be able to
        // make the lead dial a member).
        if (outcome.ok) {
          // SAFETY: `value` is a peer's HTTP body after `res.json()` — a JsonValue by construction,
          // the same cast and the same reason as `foldPeerMemory`'s. `parsePeerPreflight` re-checks
          // every field, and anything half-formed reads as `null`, which is unknown and blocks.
          this.deps.registry.recordPreflight(memberId, parsePeerPreflight(outcome.value as JsonValue));
        }
        const previous = this.memory.get(memberId);
        const next = foldPeerMemory(previous, outcome, this.now());
        this.memory.set(memberId, next);
        // The question the reset counter exists to ask is now settled for this member: it answered a
        // real dial. Whatever it took to get here, the ladder starts from zero again (M20/02).
        if (outcome.ok) this.contactResets.delete(memberId);
        this.logVerdict(memberId, outcome, previous, next);
        // Identity, not equality: `parsePeerSnapshot` mints a fresh object on every success and the
        // fold RETAINS the old one on every failure, so `!==` is exactly "this poll produced a body".
        // An unchanged peer still yields a new object each poll — a diff of nothing, which is what
        // makes the notifier's dedupe cheap rather than a second cache to keep honest.
        if (next.body !== null && next.body !== previous?.body) {
          this.deps.onPeerSnapshot?.(memberId, next.body);
        }
      }
      // §20's fold, after every member's answer is banked: who is behind, who is moving, who fell
      // back, and who has now missed three sweeps. A turn RELEASED here earns an immediate re-sweep
      // — the third of the three triggers — so the next member starts within one sweep of its turn
      // rather than within the periodic cadence.
      // A DIFFERENT run now, or none: everything above was banked for the old one. The registry
      // keeps what the peers said, which is true whatever run is live, and the fold is skipped —
      // the immediate re-sweep below asks the new run's own question, with its own `due`.
        if ((follow?.turns.current()?.runId ?? null) !== runAtStart) {
        this.resweep();
        return;
      }
      this.foldTurns(follow, folded, outcomes);

      // ── TWO INDEPENDENT DISTRIBUTIONS, TWO INDEPENDENT GUARDS ─────────────
      // They used to share this try, and a live drill showed what that costs: the warrant half awaits
      // a store write (the hourly refresh), so any failure there took the pairing half down with it
      // for every sweep thereafter — silently, since the outer catch logs one line about "the sweep".
      // Neither is the other's precondition, so neither may be the other's single point of failure.
      await this.guarded("warrant distribution", () => this.distributeWarrant(folded, outcomes));
      await this.guarded("pairing sync", async () => this.distributePairing(folded, outcomes));
    } catch (err) {
      // Defensive: nothing above is supposed to reject. If something does, the crew degrades to
      // "stale" rather than taking the lead's poll loop down with it.
      console.warn(`[crew] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * §20's fold, after every member's answer is banked: who is behind, who is moving, who fell back,
   * and who has now missed three sweeps.
   *
   * Called on EVERY sweep tick, including one where nobody was due — the leg fold, the wall clock
   * and the settle check are the run's only way to end, so a tick that skips them is a tick a frozen
   * run survives. A turn RELEASED here earns an immediate re-sweep, the third of the three triggers,
   * so the next member starts within one sweep of its turn rather than within the periodic cadence.
   */
  private foldTurns(
    follow: CrewLeadDeps["follow"],
    due: readonly CrewLink[],
    outcomes: ReadonlyMap<string, PeerOutcome<unknown>>,
  ): void {
    if (follow === undefined) return;
    const members = due.map((link): TurnMember => {
      const outcome = outcomes.get(link.memberId);
      const state = this.deps.registry.state(link.memberId);
      const turnMember: TurnMember = {
        memberId: link.memberId,
        enrolledAt: follow.enrolledAt(link.memberId),
        version: state.version,
        verdict: state.preflight?.verdict ?? null,
        answered: outcome?.ok === true,
        // SAFETY: `value` is a peer's HTTP body after `res.json()` — a JsonValue by
        // construction, the same cast and the same reason as `parsePeerPreflight`'s above.
        run: outcome?.ok === true ? parsePeerRun(outcome.value as JsonValue) : null,
      };
      // §19's field, banked with the rest of that member's own report. Assigned only when the
      // member named a kind: absent is what "this member named no kind" has to look like, and
      // absent counts as not packaged.
      const kind = state.preflight?.installKind;
      return kind === undefined ? turnMember : { ...turnMember, installKind: kind };
    });
    if (follow.turns.observe(members, this.now()).released) this.resweep();
  }

  /**
   * Name one member's verdict in the journal, **once per transition**.
   *
   * The 2026-09-07 drill is the whole argument: a run sat on the incompatible ladder for fifteen
   * minutes and the journal held not one line about it, so the cause had to be inferred from the
   * arithmetic. The key is the state the line named, so a member repeating itself writes nothing and
   * an advance of the backoff writes exactly one line.
   */
  private logVerdict(
    memberId: string,
    outcome: PeerOutcome<unknown>,
    previous: PeerMemory | undefined,
    next: PeerMemory,
  ): void {
    // The runs count is part of the key: each step of the ladder is its own transition, and the
    // operator needs the step it reached, not just that it is on one.
    const key = outcome.ok
      ? "ok"
      : outcome.state === "incompatible"
        ? `incompatible:${next.incompatibleRuns}`
        : outcome.state;
    if (this.loggedState.get(memberId) === key) return;
    const first = this.loggedState.get(memberId) === undefined;
    this.loggedState.set(memberId, key);
    if (outcome.ok) {
      // A member's first answer is not a recovery, so it says nothing — the crew page already
      // renders a healthy peer, and a line per member per boot would be noise.
      if (first) return;
      const runs = previous?.incompatibleRuns ?? 0;
      this.log(
        runs > 0
          ? `[crew] ${memberId}: reachable again after ${runs} incompatible verdict(s)`
          : `[crew] ${memberId}: reachable again`,
      );
      return;
    }
    if (outcome.state === "incompatible") {
      const seconds = Math.round(incompatibleBackoffMs(next.incompatibleRuns) / 1000);
      this.log(`[crew] ${memberId}: incompatible (${outcome.reason}), next dial in ${seconds}s`);
      return;
    }
    this.log(`[crew] ${memberId}: ${outcome.state} (${outcome.reason})`);
  }

  /**
   * Bring every member that just answered up to the warrant this lead currently issues (§18, RFC §5).
   *
   * **NO NEW TIMER, and no new dial to decide.** The comparison rides the `snapshot` answer this
   * sweep already collected — two optional fields on a body that was fetched anyway — so a crew whose
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
      console.warn(`[crew] ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async distributeWarrant(due: readonly CrewLink[], outcomes: Map<string, PeerOutcome<unknown>>): Promise<void> {
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
  private distributePairing(due: readonly CrewLink[], outcomes: Map<string, PeerOutcome<unknown>>): void {
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
        console.warn(`[crew] pairing sync failed: ${err instanceof Error ? err.message : String(err)}`);
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
    link: CrewLink,
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
    link: CrewLink,
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
      // Defensive, exactly as `sweep` and `probe` are: failure is a value everywhere in the crew
      // client, so a throw here is a bug in an injected transport — and it must not become an
      // unhandled rejection that takes the bridge down.
      console.warn(`[crew] warrant push failed: ${err instanceof Error ? err.message : String(err)}`);
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
  private probe(link: CrewLink): void {
    const hello = this.deps.hello;
    if (hello === undefined || this.probing.has(link.memberId)) return;
    this.probing.add(link.memberId);
    void this.runProbe(hello, link);
  }

  /** The probe's body. Separate so {@link probe} can start it without awaiting it. */
  private async runProbe(
    hello: NonNullable<CrewLeadDeps["hello"]>,
    link: CrewLink,
  ): Promise<void> {
    // The probe is a DIAL, so it takes a generation like any other. It is also the reply most likely
    // to be overtaken: it runs on the patient budget, off the tick and un-awaited, so the next sweep
    // can easily answer first.
    const dialGeneration = this.nextDialGeneration(link.memberId);
    try {
      const outcome = await hello(link);
      if (this.staleDial(link.memberId, dialGeneration, "hello")) return;
      if (this.deps.registry.links().some((l) => l.memberId === link.memberId)) {
        this.deps.registry.recordProbe(link.memberId, outcome, { version: outcome.ok ? outcome.value.version : null });
        // A probe that ANSWERED is the same evidence an inbound dial is: this machine is reachable,
        // whatever the ladder says (M20/02). It goes through the same seam, so it obeys the same two
        // floors, and it dials nothing of its own — the next sweep tick does.
        if (outcome.ok) this.noteAdmittedContact(link.memberId);
        // M22/03: ASSIGNED, never merged. Whatever this hello said about that member's multiplexer
        // is now the whole answer for it, and a hello that said nothing drops the entry — which
        // reads as "use the lead's", not as "every capability present". See {@link muxBlocks}.
        if (outcome.ok) this.setCapabilities(link.memberId, outcome.value.mux ?? null);
      }
    } catch (err) {
      // Defensive, exactly as `sweep` is: failure is a value everywhere in the crew client, so a
      // throw here is a bug in an injected transport — and it must not become an unhandled rejection
      // that takes the bridge down.
      console.warn(`[crew] probe failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.probing.delete(link.memberId);
    }
  }

  /**
   * Ask a member what its multiplexer can do, at most once per link (M22/03). See {@link muxAsked}.
   */
  private learnCapabilities(link: CrewLink): void {
    if (this.muxAsked.has(link.memberId)) return;
    this.probe(link);
  }

  /** Record one hello's whole answer about a member's multiplexer. See {@link muxBlocks}. */
  private setCapabilities(memberId: string, block: MuxConfig | null): void {
    this.muxAsked.add(memberId);
    if (block === null) this.muxBlocks.delete(memberId);
    else this.muxBlocks.set(memberId, block);
  }

  /**
   * What one member said its multiplexer can do, or `null` when it has said nothing (M22/03).
   *
   * `null` is the answer for a member that publishes no block, for one this lead has not managed a
   * hello with yet, and for a member id nobody holds. The `/api/config` route reads all three the
   * same way and answers with the LEAD's own block, which is byte for byte the reading the phone
   * gives every pane today. It dials nobody, for the reason {@link CrewLead.updateRows} does not: a
   * surface the phone polls must not be able to make the lead reach a machine.
   */
  muxFor(memberId: string): MuxConfig | null {
    return this.muxBlocks.get(memberId) ?? null;
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
    resolved: { readonly link: CrewLink; readonly state: PeerState },
    opts: { readonly audit?: ForwardDeps["audit"]; readonly device?: string | null } = {},
  ): Promise<Response> {
    return forwardToPeer(req, url, {
      link: resolved.link,
      state: resolved.state,
      transport: this.deps.proxy,
      // This lead's own cap, for §13's refuse-before-forward. The peer enforces its own on arrival.
      maxUploadBytes: this.deps.maxUploadBytes,
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

  /**
   * Every member's update row, composed from what the sweep BANKED and from nothing else (§19).
   *
   * The card's `crew` array. It dials nobody — the same guarantee `crewStatusBody` makes and for the
   * same reason: a surface the phone polls must not be able to make the lead reach a machine.
   */
  /**
   * Every peer's LEG of the run this lead is driving (§20, M16/04), from what the sweep banked.
   *
   * Empty when no run is being driven, which is every ordinary minute of a crew's life. It dials
   * nobody, for the reason {@link CrewLead.updateRows} does not.
   */
  updatePeers(): PeerLeg[] {
    return this.deps.follow?.turns.peerLegs() ?? [];
  }

  /** The run those legs describe, live or over, or null. The composer checks it before it attaches. */
  updateLegsRun(): string | null {
    return this.deps.follow?.turns.legsRun() ?? null;
  }

  /**
   * When the run this lead drove last reached a terminal state on every leg, or null while one is
   * still open (M20/01).
   *
   * The band and the Updates card both read this one value, so neither can claim the crew is moving
   * after the other has gone quiet. It dials nobody.
   */
  updateSettledAt(): number | null {
    return this.deps.follow?.turns.settledAt() ?? null;
  }

  /**
   * An admitted peer reached this lead, so the backoff this lead is holding against it is stale
   * (M20/02). Mark it due now and return.
   *
   * **This never dials.** It writes `probeAfter = 0` and the next sweep tick, 1.5 s away, does the
   * dial — which keeps one dialler in this process and keeps `this.probing` meaningful. A handler
   * that dialled would let an inbound request make this lead reach a machine, which is the thing
   * `updateRows` and `updatePeers` are careful never to allow either.
   *
   * **Admitted is the caller's word and it is granted by POSITION**, exactly as the peer-check
   * exemption is (`bridge/server.ts`): the one caller sits in `bridge/crew/router.ts` after
   * `admitCrewRequest` has passed both factors, the pin and the secret, and after the deputy is
   * refused. No browser route can reach it, because no browser route is on that side of the check.
   *
   * Two floors bound it, {@link CONTACT_RESET_FLOOR_MS} and {@link MAX_CONTACT_RESETS}.
   */
  noteAdmittedContact(memberId: string): void {
    // A caller this lead does not lead is not a member whose schedule this owns.
    if (!this.deps.registry.links().some((l) => l.memberId === memberId)) return;
    const memory = this.memory.get(memberId);
    // No entry is already due, and a zero `probeAfter` is already due. Neither spends a reset: the
    // counter must count resets that actually changed something, or an ordinary healthy peer's
    // traffic would exhaust its own allowance and take the shortcut away when it finally needed it.
    if (memory === undefined || memory.probeAfter === 0) return;
    const now = this.now();
    const seen = this.contactResets.get(memberId);
    if (seen !== undefined) {
      if (now - seen.at < CONTACT_RESET_FLOOR_MS) return;
      if (seen.count >= MAX_CONTACT_RESETS) return;
    }
    const cleared = clearPeerBackoff(memory);
    if (cleared === undefined) return;
    this.memory.set(memberId, cleared);
    this.contactResets.set(memberId, { at: now, count: (seen?.count ?? 0) + 1 });
  }

  /**
   * One immediate sweep, off this tick.
   *
   * **Not a timer** (§10.1, §11): a microtask, fired at most once per turn release, so the member
   * next in line starts within one sweep of its turn instead of waiting out the idle cadence. The
   * re-entrancy guard in {@link CrewLead.sweep} is what keeps it from stacking.
   */
  resweep(): void {
    queueMicrotask(() => void this.sweep());
  }

  updateRows(): CrewUpdateRow[] {
    return crewUpdateRows(
      this.contributions().map((c) => ({ name: c.name, version: c.state.version, preflight: c.state.preflight })),
    );
  }

  /**
   * Fold the lead's own body into the merged one. The only re-serialisation on a crew link (§9.2).
   *
   * `plan` is the request's own "how much of which machine" (M22/06), and it is REQUIRED rather than
   * defaulted: every cached body here is a widened one, so a caller that could forget the plan would
   * be a caller that hands the phone every session of every member. The narrowing is one function,
   * `narrowPeerBody`, and this is its only call site — the merge narrows, nothing else does.
   */
  merge(local: SnapshotResponse, plan: SnapshotPlan): SnapshotResponse {
    return mergeSnapshot(local, {
      self: this.deps.self,
      peers: this.contributions().map((c) =>
        Object.assign({}, c, { body: narrowPeerBody(c.body, plan.peer(c.state.memberId)) }),
      ),
      now: this.now(),
    });
  }
}

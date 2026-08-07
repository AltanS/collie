import type { SnapshotResponse } from "../types.ts";
import { mergeSnapshot, parsePeerSnapshot, type PeerContribution, type PeerSnapshotBody } from "./merge.ts";
import { sweepPeers, type PackLink, type PeerOutcome } from "./peer-client.ts";
import type { HostResolution, HostSelector, PackRegistry } from "./registry.ts";

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
    const parsed = parsePeerSnapshot(outcome.value);
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
  /** This collie's member id and label — the `servers[0]` entry (§9.2). */
  readonly self: { readonly id: string; readonly name: string };
  readonly now?: () => number;
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
      for (const id of this.deps.registry.prune()) this.memory.delete(id);

      const now = this.now();
      const due = this.deps.registry.links().filter((l) => dueForProbe(this.memory.get(l.memberId), now));
      if (due.length === 0) return;

      const outcomes = await sweepPeers(due, (link) => this.deps.snapshot(link));
      for (const [memberId, outcome] of outcomes) {
        this.deps.registry.record(memberId, outcome);
        this.memory.set(memberId, foldPeerMemory(this.memory.get(memberId), outcome, this.now()));
      }
    } catch (err) {
      // Defensive: nothing above is supposed to reject. If something does, the pack degrades to
      // "stale" rather than taking the lead's poll loop down with it.
      console.warn(`[pack] sweep failed: ${(err as Error).message}`);
    } finally {
      this.sweeping = false;
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

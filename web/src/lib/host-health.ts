// TIER 2 of the two-tier connection model: lead↔peer. A pure derivation from the snapshot's
// `servers[]` to a per-host presentation state. No timers, no listeners, no module-mutable state,
// no `useSyncExternalStore` — call it, get an answer, throw it away.
//
// ── WHY THIS IS NOT IN lib/connection-health.ts ──────────────────────────────
// That module is TIER 1, phone↔lead, and it is deliberately ONE module-scoped clock: three
// variables, five mutators, one latch. Its header comment records why (escalation used to live in a
// per-component ref/timer, two instances diverged, and the banner went red while the header pill sat
// amber). Giving it a host dimension — a map of anchors, a `markLive(host)`, N latches — would
// re-create that exact divergence by construction, once per pack member. So the seam is structural,
// not a matter of discipline: tier 2 lives HERE, gains no clock, and tier 1 gains no host argument.
// `grep -n "reachable\|host" lib/connection-health.ts` is empty and host-health.test.ts keeps it so.
//
// The two tiers compose by SUBORDINATION, never by mixing:
//   - The lead being unreachable is tier 1's answer and it covers everything (the ConnectionBanner,
//     the dog, the polling pause, the offline navigation fast path). Nothing here participates.
//   - A peer being unreachable is tier 2's answer and it degrades only that host's rows and panes.
//     It never feeds `isConnecting`, never reaches `latchLost()`, never pauses a poll: a snapshot
//     the lead served while a peer was down is a LIVE poll, and `api.ts` stamps it as one.
//
// ── AND WHY THE CLOCK HERE IS THE LEAD'S, NOT THE BROWSER'S ──────────────────
// `ServerSummary.lastSeenAt` is stamped by the LEAD on receipt (PACK_PROTOCOL.md §10.2 — "a peer's
// clock is never trusted"), so the only sound thing to measure it against is the lead's clock too:
// the snapshot's own `ts`. Subtracting a phone's `Date.now()` from a lead's timestamp measures the
// skew between two machines as much as it measures staleness — on a phone a few minutes fast, every
// peer in the pack would read stale forever; a few minutes slow, none ever would.
//
// The freshness of the SNAPSHOT itself is a different question with a different clock (the browser's)
// and it already has an owner: tier 1. That is the whole orthogonality — tier 1 asks "how old is
// what I'm holding", tier 2 asks "how old was the peer data when the lead assembled it".
//
// Consequence worth naming: with polling paused (the idle lock, ADR 0007) `ts` freezes along with
// `lastSeenAt`, so ages stop advancing rather than drifting into a false alarm. That is safe because
// the lock COVERS the screen and its release refetches before uncovering (`beginCatchUp` in
// hooks/use-polling.ts) — nobody ever reads a paused tier-2 state.

import { timeAgoShort } from "./format";
import type { ServerSummary } from "./types";

/**
 * Three states and no more (PACK_PROTOCOL.md §10.2's table, read as presentation):
 *
 * - `live` — the lead's last poll of this member landed inside the tolerance below.
 * - `stale` — the lead has not heard from it recently enough, and we still hold its last-good
 *   content. Its rows and panes STAY, labelled: a triage list that flickers is worse than one that
 *   is honestly stale, and the blocked agent you opened the app for is exactly the one on the
 *   machine that just went quiet.
 * - `unknown` — not reachable and never seen at all (`lastSeenAt === 0`): a first visit during an
 *   outage. There is no last-good content to show, so the UI must say so rather than spin forever.
 *
 * Incompatible is deliberately NOT a fourth state — it is a separate axis ({@link HostHealth.incompatible}),
 * because it answers "why", not "what do I render". A member speaking another protocol still has
 * last-good content or doesn't, exactly like an unreachable one.
 */
export type HostState = "live" | "stale" | "unknown";

export interface HostHealth {
  /** The member id — the `?h=` value. */
  host: string;
  /** Operator-facing name (falls back to the id). */
  name: string;
  state: HostState;
  /**
   * Whether a write may be ATTEMPTED. Deliberately NOT derived from {@link state}: it is the lead's
   * belief in the current snapshot, with no staleness tolerance applied at all.
   *
   * The asymmetry is the point. Presentation is smoothed so a single missed poll doesn't flap a chip
   * (§10.2's threshold); refusal is not smoothed, because the lead will answer a write to a member it
   * believes unreachable with `host_unreachable` (503, §10.3) no matter how recently it last heard
   * from it — and because a reply landing on the wrong machine, or appearing to land and not landing,
   * is this milestone's unforgivable failure. A UI that stays enabled through the tolerance window is
   * a UI that lies for up to three polls about where your keystrokes went.
   */
  writable: boolean;
  /** Version negotiation failed (§7) — refused, and NOT retried on the ordinary poll. */
  incompatible: boolean;
  /** The peer's refusal reason, verbatim; rendered as text, never paraphrased. */
  protocolDetail?: string;
  /** Epoch ms on the LEAD's clock; `0` = never answered. */
  lastSeenAt: number;
  /** "last seen 4m" / "never seen", computed once, against the lead's clock — see the header. */
  lastSeenLabel: string;
  /** The lead's own entry. Its health is tier 1's answer, never this module's — see {@link hostHealth}. */
  isLead: boolean;
}

/**
 * The ceiling on the presented-stale tolerance (PACK_PROTOCOL.md §10.2): "older than `3 × pollMs`
 * **or** 15 s, whichever comes first". 15 s is also `CONNECTION_LOST_MS` — deliberately the same
 * number, because §10.2 sets the peer's tolerance to "the same tolerance the herd link already gets".
 * Not imported from connection-health.ts: an equal value is not a shared dependency, and importing it
 * would be the first thread of exactly the coupling this module exists to prevent.
 */
export const PRESENTED_STALE_MAX_MS = 15_000;

/**
 * How old the lead's last receipt from a member may be before that member is presented stale:
 * `min(3 × pollMs, 15s)`. Three polls, so one dropped sweep — or two — is invisible; capped at 15 s
 * so a cold 4 s cadence can't buy a peer 12 s of undeserved green on top.
 */
export function staleThresholdMs(pollMs: number): number {
  return Math.min(3 * Math.max(0, pollMs), PRESENTED_STALE_MAX_MS);
}

export interface HostHealthOptions {
  /**
   * The LEAD's clock at snapshot time — i.e. `SnapshotResponse.ts`, threaded through `HomeData.ts`.
   * Never `Date.now()`: see the module header on why a cross-machine subtraction is not staleness.
   */
  at: number;
  /** The poll cadence currently running (hooks/use-polling `intervalFor`), for the tolerance above. */
  pollMs: number;
}

/**
 * One member's health.
 *
 * **The lead is unconditionally `live` here, and that is a tier boundary, not an optimism.** Whether
 * the phone can reach the lead is tier 1's single question with tier 1's single answer (the banner,
 * the pill, the dog, the polling pause) — if this module also rendered the lead degraded, the two
 * tiers would be answering the same question in two places, which is the divergence
 * connection-health.ts was written to eliminate. A lead we cannot reach produces no fresh snapshot at
 * all, so there is nothing here to derive from anyway.
 */
export function hostHealth(s: ServerSummary, { at, pollMs }: HostHealthOptions): HostHealth {
  const name = s.name || s.id;
  const lastSeenLabel =
    s.lastSeenAt > 0 ? `last seen ${timeAgoShort(s.lastSeenAt, at)}` : "never seen";
  const incompatible = s.protocol === "incompatible";
  const base = {
    host: s.id,
    name,
    incompatible,
    protocolDetail: s.protocolDetail,
    lastSeenAt: s.lastSeenAt,
    lastSeenLabel,
    isLead: s.isLead,
  };

  if (s.isLead) return { ...base, state: "live", writable: true };

  const neverSeen = s.lastSeenAt <= 0;
  // An incompatible member is NOT retried on the ordinary poll (§10.2 — "probed on a slow backoff"),
  // so the missed-poll tolerance below would be measuring a sweep that isn't happening. It presents
  // as its last-good content immediately, or as `unknown` if there never was any.
  if (incompatible) {
    return { ...base, state: neverSeen ? "unknown" : "stale", writable: false };
  }

  // Age on ONE clock (the lead's) — see the header. Clamped at 0 so a snapshot assembled a
  // microsecond before its own receipt stamp can't read as negative age.
  const age = Math.max(0, at - s.lastSeenAt);
  // Inside the tolerance the member is live whether or not the LAST poll landed — that is the whole
  // point of §10.2's threshold ("below that, a single missed poll is invisible"). Outside it, a member
  // that has never answered has nothing to show (`unknown`); one that has is `stale`, even if the
  // lead calls it reachable: the sweep runs on its own cadence, and "it answered, eventually" is not
  // the same claim as "this is current" — which is also what keeps a resumed idle lock honest.
  //
  // `at <= 0` means we have no lead clock to measure against (`ts` absent, or the empty stale shape
  // in loaders.ts). Then the tolerance is not "assume fresh" — it is *skipped*, and the lead's plain
  // boolean is presented as-is. Assuming fresh would turn a missing field into a green light on the
  // one axis where a wrong answer types into somebody's terminal.
  const withinTolerance = neverSeen
    ? false
    : at > 0
      ? age <= staleThresholdMs(pollMs)
      : s.reachable;
  const state: HostState = withinTolerance ? "live" : neverSeen ? "unknown" : "stale";

  return { ...base, state, writable: s.reachable };
}

/**
 * Every member's health, keyed by member id. Empty for a solo snapshot (no `servers` at all, §11), so
 * every lookup below answers `undefined` and every surface renders exactly what it renders today —
 * the hide rule is data, not a mode flag.
 */
export function hostHealthMap(
  servers: readonly ServerSummary[] | undefined,
  opts: HostHealthOptions,
): Map<string, HostHealth> {
  const out = new Map<string, HostHealth>();
  for (const s of servers ?? []) out.set(s.id, hostHealth(s, opts));
  return out;
}

/**
 * The health of a host id. `undefined` means "nothing to say" — a solo install, or a host the
 * snapshot doesn't list.
 *
 * Distinguishing "solo" from "listed but sick" is the caller's job because only the caller knows
 * whether there is a pack at all — see `useHostHealth` in components/pack-provider.tsx, which pairs
 * this with {@link departedHealth} for the one case the map can't answer.
 */
export function healthFor(
  map: ReadonlyMap<string, HostHealth>,
  host: string | undefined,
): HostHealth | undefined {
  return host === undefined ? undefined : map.get(host);
}

/**
 * The health of a host the snapshot does NOT list, on a pack that does list others — a member that
 * departed (or was demoted) while you were looking at one of its panes.
 *
 * It is not assumed healthy. There is no reachability fact attached to it at all, and on a surface
 * that types into a real terminal, "no fact" and "fine" are not the same answer: the write is refused
 * and the rows are labelled, exactly as an unreachable member's are. `lastSeenAt: 0` is honest — this
 * lead has told us nothing about it — and reads as `unknown`, i.e. "nothing here to show you".
 */
export function departedHealth(host: string): HostHealth {
  return {
    host,
    name: host,
    state: "unknown",
    writable: false,
    incompatible: false,
    lastSeenAt: 0,
    lastSeenLabel: "never seen",
    isLead: false,
  };
}

/**
 * The reason a write to this host must be refused before it is attempted, or `undefined` when it may
 * proceed. PACK_PROTOCOL.md §10.3: refusal names the member and its `lastSeenAt`; an incompatible
 * member is refused with the protocol reason verbatim.
 *
 * The lead refuses these anyway (503 `host_unreachable` / `host_incompatible`), so this is not the
 * safety mechanism — it is the HONESTY mechanism. There is no queue and no retry (§10.3, and ADR
 * 0005's reasoning about a key queue outliving its dock): a send whose outcome is unknown must be
 * surfaced, never re-sent, so the only kind one can safely refuse is the one not yet attempted.
 */
export function writeRefusal(h: HostHealth | undefined): string | undefined {
  if (h === undefined) return undefined;
  if (h.incompatible) {
    return `${h.name} is running an incompatible Collie${h.protocolDetail ? ` — ${h.protocolDetail}` : ""}`;
  }
  if (!h.writable) return `${h.name} is unreachable · ${h.lastSeenLabel}`;
  return undefined;
}

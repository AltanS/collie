import type { JsonObject, JsonValue } from "../json.ts";
import type { PinnedDeputy } from "./admission.ts";
import type { PackChange, RosterEntry } from "./enrollment.ts";
import { fingerprintOfCert } from "./identity.ts";
import type { PackLink, PeerOutcome } from "./peer-client.ts";
import type { RosterRow, TrustedMember, TrustStoreData, Warrant } from "./trust-store.ts";
import { currentWarrant, parseWarrant, verifyWarrantSignature, warrantExpired } from "./warrant.ts";

// The takeover exchange (RFC §7, PACK_PROTOCOL.md §18.16): the one thing that SPENDS a warrant.
//
// ── THREE STEPS, AND THE ORDER IS THE SAFETY ─────────────────────────────────
//   (a) **Ask the lead first.** One patient `hello`. If it answers, the takeover is REFUSED and
//       nothing anywhere has changed — not a byte, not a store, not a pin.
//   (b) **Ask the peers, twice.** A `probe` round that changes nothing anywhere, then a `commit`
//       round. **Any peer answering `lead_is_alive` aborts the whole thing**, before the deputy has
//       written anything. That is the partition defence and it is why the exchange is two-phase: a
//       peer its lead dialled two seconds ago is direct evidence that the deputy's silence is the
//       DEPUTY's own network problem.
//   (c) **Commit locally, last.** Only after the reachable peers have re-pinned does this machine
//       rewrite its own store as a lead's.
//
// **This is not a vote.** No peer is asked what it thinks should happen; each is asked one factual
// question about its own inbox (`lastDialledAt`, RFC §10.1), and one honest *no* is decisive. A
// two-machine pack has no witness, is allowed anyway, and the page says so (RFC §16, decision 8) —
// there, step (a) is the whole evidence base and the operator is the quorum (ADR 0026).
//
// **Partial success is representable and is not a failure.** A peer unreachable during (b) is carried
// on the new lead as `rePinPending` and reconciled by RFC §9 automatically, on the new lead's own
// sweep, with no operator step. A peer that answered `lead_is_alive` is not partial; it is an abort.
//
// PURE except for the injected dials and the injected commit — every decision below is a function of
// data, which is what makes the refusal matrix a table test rather than a test of a socket.

/** `POST /pack/v1/takeover`'s phase. **Absent means `probe`** — the reading that changes nothing. */
export type TakeoverPhase = "probe" | "commit";

/** The machine-readable `code` on a peer's "my lead called me recently" refusal (RFC §7.1). */
export const LEAD_IS_ALIVE = "lead_is_alive";

/** The body of `POST /pack/v1/takeover`. */
export interface TakeoverRequest {
  readonly phase: TakeoverPhase;
  readonly warrant: Warrant;
  /**
   * Where the peer should dial the deputy once it leads. A **hint, never an identity** (§4): what is
   * pinned is the certificate this peer already anchored, and an address the operator may re-point is
   * the only thing this field is allowed to decide. Required on `commit`; ignored on `probe`.
   */
  readonly address: string | null;
}

function asRecord(value: JsonValue | undefined): JsonObject | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

/**
 * Read a takeover request, or `null` for anything that is not one.
 *
 * `phase` is additive-optional with the closed reading: an absent or unrecognised value is `probe`,
 * so **a commit must be asked for explicitly** and a body that lost a field in transit can only ever
 * select the reading that writes nothing.
 */
export function parseTakeoverRequest(value: JsonValue | undefined): TakeoverRequest | null {
  const body = asRecord(value);
  const warrant = parseWarrant(body?.warrant);
  if (warrant === null) return null;
  const phase: TakeoverPhase = body?.phase === "commit" ? "commit" : "probe";
  const address = typeof body?.address === "string" && body.address !== "" ? body.address : null;
  return { phase, warrant, address };
}

// ── The peer's half ──────────────────────────────────────────────────────────

/** Why a peer refused a takeover claim. Local vocabulary; the wire says far less. */
export type TakeoverRefusal =
  /** This collie is not a peer of the warrant's issuer, or is in no pack at all. */
  | "not-a-peer"
  /** A warrant for another pack, or one this collie's own lead did not issue. */
  | "foreign"
  /** The signature does not verify against the pinned lead's certificate. */
  | "bad-signature"
  /** The caller is not the member this warrant names as deputy — or not the key it names. */
  | "not-the-deputy"
  /** A generation below the one this collie already holds. Older warrants never run backwards. */
  | "generation"
  /** Past `refreshedAt + WARRANT_TTL_MS` on this collie's own clock. */
  | "expired";

export type TakeoverVerdict =
  /** `fingerprint` is the ANCHORED certificate's, already proven equal to the warrant's claim. */
  | { readonly kind: "accept"; readonly warrant: Warrant; readonly deputy: PinnedDeputy; readonly fingerprint: string }
  | { readonly kind: "refuse"; readonly reason: TakeoverRefusal };

/**
 * Is this caller allowed to take the crown here? (RFC §7.1's (b), verified on the PEER.)
 *
 * Every clause is a question about material this collie already holds — its own pack id, the
 * certificate it pinned as its lead's, the certificate it anchored as the deputy's, its own
 * generation counter and its own clock. **Nothing is decided by the caller**, and in particular the
 * deputy's certificate is never read off the wire: it is the one this listener was BUILT with
 * (`transport.ts` → `deputyAnchorOf`), which is also the only certificate that could have completed
 * the handshake.
 *
 * Order runs outside-in like every other receiving rule in this codebase: shape, then whose warrant,
 * then the signature, then who is presenting it, then the generation, then the clock.
 */
export function checkTakeoverClaim(
  data: TrustStoreData | null,
  warrant: Warrant,
  caller: PinnedDeputy,
  now: number,
): TakeoverVerdict {
  const lead = data?.lead ?? null;
  if (data === null || data.pack === null || lead === null || lead.status !== "enrolled") {
    return { kind: "refuse", reason: "not-a-peer" };
  }
  if (warrant.packId !== data.pack.packId || warrant.leadMemberId !== lead.memberId) {
    return { kind: "refuse", reason: "foreign" };
  }
  if (!verifyWarrantSignature(warrant, lead.certPem)) return { kind: "refuse", reason: "bad-signature" };
  // The presenter must BE the member this warrant names, by id and by key. A warrant is a public
  // object (RFC §12, F6), so anyone who ever held one could replay it; binding it to the certificate
  // that completed this handshake is what makes a replay by a third member prove nothing.
  if (warrant.deputyMemberId !== caller.memberId) return { kind: "refuse", reason: "not-the-deputy" };
  const fingerprint = fingerprintOfCert(caller.certPem);
  if (fingerprint === null || warrant.deputyFingerprint !== fingerprint) {
    return { kind: "refuse", reason: "not-the-deputy" };
  }
  // Monotone, exactly as the warrant push is (RFC §4.4): a generation below the one held is a replay,
  // and it is refused rather than ignored so the deputy learns its warrant is stale.
  if (warrant.generation < (currentWarrant(data)?.warrant.generation ?? 0)) {
    return { kind: "refuse", reason: "generation" };
  }
  if (warrantExpired(warrant, now)) return { kind: "refuse", reason: "expired" };
  return { kind: "accept", warrant, deputy: caller, fingerprint };
}

/** The `probe` answer, as data: the one factual question a witness is asked (RFC §7.1). */
export interface ProbeAnswer {
  readonly ok: boolean;
  readonly witness?: "silent";
  readonly code?: string;
  readonly lastDialledAgoMs: number;
}

/**
 * A witness's own answer about its own inbox. **It changes nothing** — that is the whole contract of
 * the probe phase, and the reason the exchange is two-phase rather than one.
 *
 * The threshold is the arming threshold itself, read from the peer's own environment, because RFC
 * §10.1's rule is that there is exactly one silence clock in the pack and every reader of it reads
 * the same number.
 */
export function probeAnswer(silentForMs: number, armMs: number): ProbeAnswer {
  if (silentForMs < armMs) return { ok: false, code: LEAD_IS_ALIVE, lastDialledAgoMs: silentForMs };
  return { ok: true, witness: "silent", lastDialledAgoMs: silentForMs };
}

/**
 * The `commit` transition on a peer: **re-pin the lead to the deputy, keep everything else.**
 *
 * The member id, the pack identity, the pack secret and this collie's own key material are all
 * untouched — §14.5's "a role change, not a re-enrollment", reached from a third direction. The
 * certificate pinned is the one this listener ANCHORED, never one off the wire, so this creates no
 * trust that did not already exist; the address is the caller's hint and is the only thing the body
 * contributes.
 *
 * The presented warrant becomes the one this collie holds, which is what advances the generation so
 * the same exchange cannot be run at it twice with an older proof (RFC §4.4).
 *
 * **Effective at the next restart, at the transport.** `server.reload({tls})` does not swap a pinned
 * `ca` (§8.1), so until this peer restarts its listener still anchors the old lead as well — which is
 * exactly right: it is how the new lead reaches it now, and the old lead reaching it gets §18.10's
 * `lead_conflict` instead of a request served against a roster that silently disagrees.
 */
export function commitTakeover(
  data: TrustStoreData,
  accepted: { readonly warrant: Warrant; readonly deputy: PinnedDeputy; readonly fingerprint: string },
  address: string,
  now: number,
): PackChange<{ readonly lead: string; readonly generation: number }> | null {
  if (data.pack === null || data.lead === null) return null;
  const lead: TrustedMember = {
    memberId: accepted.deputy.memberId,
    // The ANCHORED certificate's own fingerprint, carried out of the verdict that proved it equal to
    // the warrant's claim — so what is pinned is the material, never the claim about it.
    fingerprint: accepted.fingerprint,
    certPem: accepted.deputy.certPem,
    address,
    role: "lead",
    status: "enrolled",
    enrolledAt: now,
    secretGeneration: data.pack.secretGeneration,
    // §8.6's replay floor is per member and must never walk backwards on a role change. This member
    // has never signed anything at this collie, so it starts where a newly pinned member starts.
    signedAt: 0,
    // Provisional until this machine is actually dialled by it, exactly as `adoptLead` marks one.
    contactedAt: null,
  };
  return {
    next: {
      ...data,
      lead,
      // A peer has no peers (§4), and a store holding both resolves to the conflict mode.
      peers: [],
      // A consent minted here is void the instant the crown moves — the same reason `demoteSelf`
      // spends it in the transition rather than beside it.
      pendingHandover: null,
      warrant: { warrant: accepted.warrant, deputyCertPem: accepted.deputy.certPem },
    },
    result: { lead: lead.memberId, generation: accepted.warrant.generation },
    audit: {
      action: "pack.takeover.adopted",
      detail: { lead: lead.memberId, generation: accepted.warrant.generation, from: data.lead.memberId },
    },
  };
}

// ── The deputy's half: adopting leadership ───────────────────────────────────

/**
 * Rewrite this machine's store as the LEAD's (RFC §7.1's (c)).
 *
 * The roster comes from the one that **rode the warrant push** (RFC §7.4): a deputy holds exactly one
 * roster entry of its own — its lead — so without it a takeover would be a takeover into a pack it
 * cannot see. The old lead is carried as an ordinary member, because it is one now, and it is the
 * member this new lead can reach at the application layer before it has healed (§8.1 path 1).
 *
 * **`rePinPending` is how partial success is represented.** Every member that did not answer the
 * commit round is marked, and RFC §9's reconciliation — the new lead's own sweep, pushing the warrant
 * on first contact — clears it with no operator step. The old lead is always marked, because it has
 * not been told anything yet and being told is what deposes it.
 *
 * **The warrant is kept, and the designation is dropped.** The pack has no deputy after a takeover
 * (RFC §14.4: naming a new one is the operator's first follow-up), but the signed object is still
 * needed for two things: it carries the generation counter, which must never reset (RFC §4.4), and it
 * IS the proof this machine hands to every pending member.
 */
export function adoptLeadership(
  data: TrustStoreData,
  opts: {
    readonly roster: readonly RosterRow[];
    readonly confirmed: ReadonlySet<string>;
    readonly now: number;
  },
): PackChange<{ readonly members: number; readonly pending: readonly string[] }> | null {
  if (data.pack === null || data.lead === null) return null;
  const generation = data.pack.secretGeneration;
  const rows: RosterRow[] = [
    // The old lead first: it is the member most likely to be reachable and the one that must be told.
    { memberId: data.lead.memberId, fingerprint: data.lead.fingerprint, certPem: data.lead.certPem, address: data.lead.address },
    ...opts.roster.filter((r) => r.memberId !== data.self.memberId && r.memberId !== data.lead?.memberId),
  ];
  const peers: TrustedMember[] = rows.map((row) => ({
    memberId: row.memberId,
    fingerprint: row.fingerprint,
    certPem: row.certPem,
    address: row.address,
    role: "peer",
    status: "enrolled",
    enrolledAt: opts.now,
    secretGeneration: generation,
    signedAt: 0,
    contactedAt: null,
    rePinPending: !opts.confirmed.has(row.memberId),
  }));
  const pending = peers.filter((p) => p.rePinPending === true).map((p) => p.memberId);
  return {
    next: {
      ...data,
      lead: null,
      peers,
      pendingHandover: null,
      // The warrant was SPENT. The pack designates nobody until the operator names one again.
      deputy: null,
    },
    result: { members: peers.length, pending },
    audit: {
      action: "pack.takeover.committed",
      detail: {
        from: data.lead.memberId,
        members: peers.length,
        pending: pending.join(",") === "" ? undefined : pending.join(","),
      },
    },
  };
}

/** Clear one member's pending re-pin — RFC §9's reconciliation, on the new lead's own sweep. */
export function clearRePin(data: TrustStoreData, memberId: string): PackChange<{ readonly member: string }> | null {
  const member = data.peers.find((p) => p.memberId === memberId);
  if (member === undefined || member.rePinPending !== true) return null;
  return {
    next: {
      ...data,
      peers: data.peers.map((p) => (p.memberId === memberId ? { ...p, rePinPending: false } : p)),
    },
    result: { member: memberId },
    audit: { action: "pack.takeover.repinned", detail: { member: memberId } },
  };
}

/** Every member still owed the proof. Read through the store each sweep, never captured. */
export function pendingRePin(data: TrustStoreData | null): ReadonlySet<string> {
  return new Set((data?.peers ?? []).filter((p) => p.rePinPending === true).map((p) => p.memberId));
}

// ── The deputy's half: running the exchange ──────────────────────────────────

/** What the whole exchange produced. Every arm is an ANSWER the page prints, never an exception. */
export type TakeoverOutcome =
  | { readonly kind: "committed"; readonly repinned: readonly string[]; readonly pending: readonly string[] }
  | { readonly kind: "refused"; readonly reason: "lead-alive"; readonly agoMs: number }
  | { readonly kind: "refused"; readonly reason: "witness"; readonly witness: string; readonly agoMs: number }
  | { readonly kind: "refused"; readonly reason: "no-warrant" }
  | { readonly kind: "refused"; readonly reason: "no-roster" }
  | { readonly kind: "refused"; readonly reason: "pairing-collision"; readonly labels: readonly string[] }
  | { readonly kind: "refused"; readonly reason: "commit-failed" };

export interface TakeoverDeps {
  /** The verified warrant naming this machine, or `null` — re-read, never captured. */
  readonly warrant: () => Warrant | null;
  /** This machine's lead, as a link. `null` ⇒ nothing to ask, which is a refusal, not a shortcut. */
  readonly leadLink: () => PackLink | null;
  /** Every OTHER member, from the roster that rode the warrant push (RFC §7.4). May be empty. */
  readonly witnesses: () => readonly PackLink[];
  /** Where a peer should dial this machine once it leads. The operator's own address, from config. */
  readonly address: () => string;
  /** Step (a): one patient `hello` at the lead. */
  readonly hello: (link: PackLink) => Promise<PeerOutcome<unknown>>;
  /** Steps (b): `POST /pack/v1/takeover`, probe then commit. */
  readonly ask: (link: PackLink, body: TakeoverBody) => Promise<PeerOutcome<JsonValue>>;
  /** Step (c): rewrite this store, adopt the pairing registry, audit. Returns what it managed. */
  readonly commit: (confirmed: ReadonlySet<string>) => Promise<CommitOutcome>;
  readonly now: () => number;
}

/** The wire body this deputy sends. `address` is only read on `commit`. */
export interface TakeoverBody {
  readonly phase: TakeoverPhase;
  readonly warrant: Warrant;
  readonly address: string;
}

/** What the local commit managed. `pairing-collision` is a refusal that changed nothing. */
export type CommitOutcome =
  | { readonly kind: "committed"; readonly pending: readonly string[] }
  | { readonly kind: "refused"; readonly reason: "no-roster" | "commit-failed" }
  | { readonly kind: "refused"; readonly reason: "pairing-collision"; readonly labels: readonly string[] };

/** Read one peer's probe answer off its body. Anything unreadable is "said nothing", which is not a veto. */
export function readProbeAnswer(value: JsonValue | undefined): ProbeAnswer | null {
  const body = asRecord(value);
  if (body === null || typeof body.ok !== "boolean") return null;
  const ago = body.lastDialledAgoMs;
  return {
    ok: body.ok,
    code: typeof body.code === "string" ? body.code : undefined,
    lastDialledAgoMs: typeof ago === "number" && Number.isFinite(ago) ? ago : 0,
  };
}

/**
 * Run RFC §7, end to end. The only thing in this module that is not a pure function of data, and even
 * it decides nothing on its own: every dial and the commit itself are injected.
 */
export async function runTakeover(deps: TakeoverDeps): Promise<TakeoverOutcome> {
  const warrant = deps.warrant();
  if (warrant === null) return { kind: "refused", reason: "no-warrant" };

  // ── (a) Ask the lead first ────────────────────────────────────────────────
  // ONE attempt, on the patient budget, and no retry: a second attempt is a slower way to get the
  // same answer, and §10.4 already establishes that a non-timeout failure is never re-probed
  // patiently. If it answers, nothing below runs and nothing anywhere has changed.
  const lead = deps.leadLink();
  if (lead === null) return { kind: "refused", reason: "no-roster" };
  const askedAt = deps.now();
  const alive = await deps.hello(lead);
  if (alive.ok) return { kind: "refused", reason: "lead-alive", agoMs: Math.max(0, deps.now() - askedAt) };

  // ── (b) Ask the peers, twice ──────────────────────────────────────────────
  const witnesses = deps.witnesses();
  const body = (phase: TakeoverPhase): TakeoverBody => ({ phase, warrant, address: deps.address() });
  const probes = await Promise.all(
    witnesses.map(async (link) => ({ link, outcome: await deps.ask(link, body("probe")) })),
  );
  const heard: PackLink[] = [];
  for (const { link, outcome } of probes) {
    if (!outcome.ok) continue; // unreachable, refusing, skewed — recorded as pending, never a veto.
    const answer = readProbeAnswer(outcome.value);
    if (answer === null) continue;
    // ONE HONEST NO IS DECISIVE. A peer its lead called inside the arming window is direct evidence
    // that this machine is the one that is cut off — so the takeover aborts here, before a byte moved.
    if (!answer.ok && answer.code === LEAD_IS_ALIVE) {
      return { kind: "refused", reason: "witness", witness: link.memberId, agoMs: answer.lastDialledAgoMs };
    }
    if (answer.ok) heard.push(link);
  }

  const confirmed = new Set<string>();
  for (const link of heard) {
    const outcome = await deps.ask(link, body("commit"));
    if (outcome.ok) confirmed.add(link.memberId);
  }

  // ── (c) Commit locally, LAST ──────────────────────────────────────────────
  const committed = await deps.commit(confirmed);
  if (committed.kind === "refused") return committed;
  return { kind: "committed", repinned: [...confirmed], pending: committed.pending };
}

/**
 * The sentence the page prints, verbatim (RFC §14.3 step 5). One renderer, so the wire, the page and
 * this machine's own journal never spell a terminal state two ways.
 *
 * **A refusal because the lead is alive is the feature, not the failure**, and it must read that way.
 */
export function takeoverMessage(outcome: TakeoverOutcome): string {
  if (outcome.kind === "committed") {
    const pending =
      outcome.pending.length === 0
        ? ""
        : ` ${outcome.pending.length} machine${outcome.pending.length === 1 ? "" : "s"} could not be reached ` +
          `(${outcome.pending.join(", ")}) and will be brought over automatically when they answer.`;
    return `This machine is the lead now.${pending} Restarting — reload in a moment.`;
  }
  if (outcome.reason === "lead-alive") {
    return `Your lead answered ${seconds(outcome.agoMs)} ago; it is alive. Nothing was changed.`;
  }
  if (outcome.reason === "witness") {
    return (
      `Peer "${outcome.witness}" says the lead called it ${seconds(outcome.agoMs)} ago; you are probably ` +
      "the one who is cut off. Nothing was changed."
    );
  }
  if (outcome.reason === "no-warrant") {
    return "No warrant here names this machine any more. Nothing was changed.";
  }
  if (outcome.reason === "no-roster") {
    return "This machine holds no roster for the pack, so it cannot lead one. Re-run `collie pack deputy` on the lead. Nothing was changed.";
  }
  if (outcome.reason === "pairing-collision") {
    return (
      `This machine already has a paired device called "${outcome.labels.join('", "')}", so your lead's ` +
      "devices cannot be adopted without renaming one. Nothing was changed."
    );
  }
  return "The takeover could not be written to this machine's own store. Nothing was changed.";
}

/** One decimal of a second, which is how a person reads a fresh answer ("0.4 s ago"). */
function seconds(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`;
}

/** The roster rows a lead sends its deputy (RFC §7.4). Public material, so nothing here is a secret. */
export function rosterRowsOf(members: readonly TrustedMember[]): RosterEntry[] {
  return members
    .filter((m) => m.status === "enrolled")
    .map((m) => ({ memberId: m.memberId, fingerprint: m.fingerprint, certPem: m.certPem, address: m.address }));
}

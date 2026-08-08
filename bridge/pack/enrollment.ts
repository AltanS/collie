import type { AuditEntry, AuditLog } from "../audit.ts";
import {
  fingerprintOfCert,
  hashToken,
  isMemberId,
  mintIdentity,
  mintMemberId,
  normalizeFingerprint,
  randomToken,
  secretEquals,
  type RandomSource,
} from "./identity.ts";
import {
  TRUST_STORE_VERSION,
  type PackIdentity,
  type PendingInvite,
  type SelfIdentity,
  type TrustStore,
  type TrustStoreData,
  type TrustedMember,
} from "./trust-store.ts";

// Enrollment, rotation and revocation, as PURE transitions over a trust store.
//
// Every function below takes the store's contents and returns the next contents plus the audit line
// the change is worth. None of them opens a file, reads a clock or generates entropy — `now` and any
// minted value are arguments. That is what makes the failure matrix in enrollment.test.ts an
// exhaustive test of the actual production path rather than of a test double.
//
// The transfer list is PACK_PROTOCOL.md §8.2's table, implemented literally:
//   peer's fingerprint → lead (pinned) · lead's fingerprint → peer (pinned) · pack secret →
//   peer · pack identity → peer · peer's member id (minted by the lead) → peer · both addresses.

/** Enrollment tokens live 10 minutes (PACK_PROTOCOL.md §8.2). Long enough to paste, short enough. */
export const INVITE_TTL_MS = 10 * 60 * 1000;

/** The protocol version this build speaks. Exact-1 window (§7) — there is no range until there is a v2. */
export const PACK_PROTOCOL_VERSION = 1;

/** The result of a transition: the next store, what the caller asked for, and the line to audit. */
export interface PackChange<T> {
  readonly next: TrustStoreData;
  readonly result: T;
  readonly audit: AuditEntry;
}

// ── This collie's own identity ───────────────────────────────────────────────

/** Freshly minted key material for this collie: a self-signed certificate and its private key. */
export interface IdentityMaterial {
  readonly certPem: string;
  readonly keyPem: string;
  /** SHA-256 of the certificate DER, lowercase hex. Computed by the minter, never re-derived here. */
  readonly fingerprint: string;
}

/**
 * Mints {@link IdentityMaterial}. Injected so a test pins exact material without generating a key —
 * and so this module, which is otherwise pure, never reaches for entropy of its own.
 */
export type IdentityMinter = () => Promise<IdentityMaterial>;

/**
 * The production minter: a self-signed EC P-256 certificate, ten years, from `identity.ts`.
 *
 * **Called on exactly one path** — `ensureStore` in `cli/pack.ts`, at the operator's first
 * `pack invite` or `join`. A solo instance never mints, never writes a key and never has a trust
 * store (§11); that is a property of *where this is called*, not of what it does, which is why it is
 * a value the CLI wires rather than a default anything could fall into.
 */
export function identityMinter(opts: { commonName: string; sans?: readonly string[] }): IdentityMinter {
  return () => Promise.resolve(mintIdentity({ commonName: opts.commonName, sans: opts.sans }));
}

/** Build this collie's identity record from freshly minted material. Pure given the material. */
export function selfIdentity(memberId: string, material: IdentityMaterial, now: number): SelfIdentity {
  return {
    memberId,
    certPem: material.certPem,
    keyPem: material.keyPem,
    fingerprint: material.fingerprint,
    createdAt: now,
  };
}

/** A brand-new trust store: an identity, no pack, no roster. The file's first contents. */
export function createTrustStore(self: SelfIdentity): TrustStoreData {
  return { version: TRUST_STORE_VERSION, self, pack: null, lead: null, peers: [], invites: [] };
}

// ── Invites (on the lead) ────────────────────────────────────────────────────

export interface MintedInvite {
  /** The token, in the clear. Shown to the operator ONCE — only its hash is persisted. */
  readonly token: string;
  readonly expiresAt: number;
}

/**
 * Mint a single-use, short-lived enrollment token, creating the pack if this is its first invite.
 *
 * The pack coming into existence here rather than at startup is the zero-tax rule in practice: a
 * lead that never invites anybody never has a pack identity, never has a secret, and therefore has
 * nothing to write. Minting an invite is the operator's first pack action, so it is the moment the
 * pack secret is generated.
 *
 * Expired invites are swept on every mint. A store is not a queue and an expired token is not a
 * record worth keeping — leaving them would slowly turn a 0600 file into a list of dead hashes.
 */
export function mintInvite(
  data: TrustStoreData,
  opts: {
    now: number;
    label?: string | null;
    ttlMs?: number;
    packName?: string;
    random?: RandomSource;
  },
): PackChange<MintedInvite> {
  const random = opts.random ?? randomToken;
  const token = random(32);
  const ttl = opts.ttlMs ?? INVITE_TTL_MS;
  const invite: PendingInvite = {
    tokenHash: hashToken(token),
    createdAt: opts.now,
    expiresAt: opts.now + ttl,
    label: opts.label ?? null,
  };
  const pack: PackIdentity = data.pack ?? {
    packId: random(16),
    name: opts.packName ?? "collie pack",
    secret: random(32),
    secretGeneration: 1,
    rotatedAt: opts.now,
  };
  return {
    next: {
      ...data,
      pack,
      invites: [...data.invites.filter((i) => i.expiresAt > opts.now), invite],
    },
    result: { token, expiresAt: invite.expiresAt },
    audit: {
      action: "pack.invite",
      // The token never reaches the log — a 0600 audit file is still a file, and this one is
      // deliberately readable by the operator's own tooling.
      detail: { label: invite.label ?? undefined, expiresAt: new Date(invite.expiresAt).toISOString() },
    },
  };
}

/**
 * Spend a token: remove it from the store and report whether it was valid *at this instant*.
 *
 * **The token is consumed whether or not the exchange goes on to succeed** (spec requirement). That
 * is why consumption is its own transition: an enrollment that fails validation later has still
 * burned the invite, so a stolen token cannot be retried against a different failure. Expired
 * invites are swept in the same pass, and that sweep is worth persisting even when nothing was
 * spent — but a **pure no-op returns `null` and writes nothing**. Nothing matched and nothing
 * expired means an unauthenticated caller reaching the enrollment endpoint would otherwise force a
 * full re-serialize of the file holding the private key and the pack secret, plus an audit line,
 * once per request. The refusal the caller sees is identical either way: `commitPackChange`
 * collapses "no change" and "changed, spent nothing" into the same `null` at the call site.
 */
export function consumeInvite(
  data: TrustStoreData,
  token: string | null,
  now: number,
): PackChange<PendingInvite | null> | null {
  const live = data.invites.filter((i) => i.expiresAt > now);
  const hash = token === null ? null : hashToken(token);
  // Constant-time against every live invite: `find` on a plain === would leak, via timing, how many
  // invites are outstanding and how close a guess was.
  let matched: PendingInvite | null = null;
  for (const invite of live) {
    if (hash !== null && secretEquals(hash, invite.tokenHash)) matched = invite;
  }
  if (matched === null && live.length === data.invites.length) return null;
  const remaining = matched === null ? live : live.filter((i) => i !== matched);
  return {
    next: { ...data, invites: remaining },
    result: matched,
    audit: {
      action: "pack.invite.spend",
      detail: { accepted: matched !== null },
    },
  };
}

// ── The exchange ─────────────────────────────────────────────────────────────

/** What the joining peer sends to the lead's enrollment endpoint. */
export interface EnrollRequest {
  readonly protocol: number;
  /** The invite token, in the clear. Never logged, never persisted (§8.3). */
  readonly token: string;
  /** The peer's certificate fingerprint, which the lead will pin. */
  readonly fingerprint: string;
  /**
   * The peer's certificate, PEM. Cross-checked against `fingerprint` before anything is pinned, so
   * the two can never be persisted disagreeing — see {@link parseEnrollRequest}.
   */
  readonly certPem: string;
  /** The address the peer will listen on, and therefore the address the lead will dial (§8.2). */
  readonly address: string;
  /** A suggested label for the peer's member id. A hint the lead may ignore. */
  readonly label: string | null;
}

/** What the lead sends back. Exactly PACK_PROTOCOL.md §8.2's transfer table, in one object. */
export interface EnrollResponse {
  readonly protocol: number;
  readonly packId: string;
  readonly packName: string;
  readonly packSecret: string;
  readonly secretGeneration: number;
  /** The member id the lead minted for the joining peer. */
  readonly memberId: string;
  readonly leadMemberId: string;
  readonly leadFingerprint: string;
  /** The lead's certificate, PEM — what the peer's listener will pin as its trust anchor (§8.1). */
  readonly leadCertPem: string;
}

// The lead's address is deliberately NOT in the response. The peer just dialled it — it is the
// argument the operator typed into `collie join` — so echoing it back would let the lead *tell* the
// peer where to find it, which is a redirect an enrollment exchange has no business performing. The
// peer records the address it reached, and §8.2's "the address the peer will listen on" travels the
// other way, in the request.

export function parseEnrollRequest(value: unknown): EnrollRequest | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.token !== "string" || v.token.length === 0) return null;
  if (typeof v.fingerprint !== "string") return null;
  const fingerprint = normalizeFingerprint(v.fingerprint);
  if (fingerprint === null) return null;
  // The certificate and the fingerprint must be the same certificate. A joiner that could have the
  // lead pin fingerprint A while the lead *enforces* certificate B would be pinned to something it
  // does not hold — the exact confusion `certPem` was added to make impossible.
  if (typeof v.certPem !== "string" || fingerprintOfCert(v.certPem) !== fingerprint) return null;
  if (typeof v.address !== "string" || v.address.length === 0) return null;
  if (v.label !== null && v.label !== undefined && typeof v.label !== "string") return null;
  return {
    protocol: typeof v.protocol === "number" ? v.protocol : Number.NaN,
    token: v.token,
    fingerprint,
    certPem: v.certPem,
    address: v.address,
    label: (v.label as string | undefined) ?? null,
  };
}

export function parseEnrollResponse(value: unknown): EnrollResponse | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const fingerprint = typeof v.leadFingerprint === "string" ? normalizeFingerprint(v.leadFingerprint) : null;
  if (
    typeof v.packId !== "string" ||
    typeof v.packName !== "string" ||
    typeof v.packSecret !== "string" ||
    typeof v.secretGeneration !== "number" ||
    !isMemberId(v.memberId) ||
    !isMemberId(v.leadMemberId) ||
    fingerprint === null ||
    typeof v.leadCertPem !== "string" ||
    fingerprintOfCert(v.leadCertPem) !== fingerprint
  ) {
    return null;
  }
  return {
    protocol: typeof v.protocol === "number" ? v.protocol : Number.NaN,
    packId: v.packId,
    packName: v.packName,
    packSecret: v.packSecret,
    secretGeneration: v.secretGeneration,
    memberId: v.memberId,
    leadMemberId: v.leadMemberId,
    leadFingerprint: fingerprint,
    leadCertPem: v.leadCertPem,
  };
}

/**
 * Lead side: pin the joining peer and mint its member id.
 *
 * Called only after {@link consumeInvite} accepted the token — this function does not check it, so
 * that the "token is spent regardless" rule cannot be quietly undone by reordering.
 *
 * A **re-join keeps the member id** but re-pins the fingerprint: that is the documented recovery
 * path for a peer dropped to `unenrolled` by a rotation it missed (§8.4), and for a peer whose disk
 * was replaced. What it must never do is silently accept a *new* certificate for a member that is
 * still enrolled — but that case cannot arrive here, because reaching this point required a fresh
 * invite the operator minted by hand.
 */
export function enrollPeer(
  data: TrustStoreData,
  req: { fingerprint: string; certPem: string; address: string; label: string | null },
  now: number,
  random: RandomSource = randomToken,
): PackChange<EnrollResponse> | null {
  if (data.pack === null) return null;
  const existing = data.peers.find((p) => p.fingerprint === req.fingerprint);
  const taken = new Set(data.peers.map((p) => p.memberId).concat(data.self.memberId));
  const memberId = existing?.memberId ?? mintMemberId(req.label, taken, random);
  const member: TrustedMember = {
    memberId,
    fingerprint: req.fingerprint,
    certPem: req.certPem,
    address: req.address,
    role: "peer",
    status: "enrolled",
    enrolledAt: now,
    secretGeneration: data.pack.secretGeneration,
    // A re-join resets the replay floor with the pin: the member is presenting a fresh certificate
    // and a fresh invite, so a timestamp from before it is not a request this link ever admitted.
    signedAt: 0,
  };
  return {
    next: {
      ...data,
      peers: [...data.peers.filter((p) => p.memberId !== memberId), member],
    },
    result: {
      protocol: PACK_PROTOCOL_VERSION,
      packId: data.pack.packId,
      packName: data.pack.name,
      packSecret: data.pack.secret,
      secretGeneration: data.pack.secretGeneration,
      memberId,
      leadMemberId: data.self.memberId,
      leadFingerprint: data.self.fingerprint,
      leadCertPem: data.self.certPem,
    },
    audit: {
      action: "pack.enroll",
      detail: { member: memberId, fingerprint: req.fingerprint, address: req.address, rejoin: existing !== undefined },
    },
  };
}

/**
 * Peer side: adopt the pack the lead just handed over, pin the lead, and take the id it minted.
 *
 * The peer's roster gains **exactly one entry** — its lead (§8.2 step 4). A peer has no peers, which
 * is why `peers` is emptied here rather than merged: a store that somehow held both would resolve to
 * the conflict mode in `deriveMode`, and this is the one place that could create that state.
 */
export function acceptEnrollment(
  data: TrustStoreData,
  res: EnrollResponse,
  /** The address this peer dialled to reach the lead — what it will dial again, from now on. */
  leadAddress: string,
  now: number,
): PackChange<{ memberId: string }> {
  const lead: TrustedMember = {
    memberId: res.leadMemberId,
    fingerprint: res.leadFingerprint,
    certPem: res.leadCertPem,
    address: leadAddress,
    role: "lead",
    status: "enrolled",
    enrolledAt: now,
    secretGeneration: res.secretGeneration,
    signedAt: 0,
  };
  return {
    next: {
      ...data,
      self: { ...data.self, memberId: res.memberId },
      pack: {
        packId: res.packId,
        name: res.packName,
        secret: res.packSecret,
        secretGeneration: res.secretGeneration,
        rotatedAt: now,
      },
      lead,
      peers: [],
      invites: [],
    },
    result: { memberId: res.memberId },
    audit: {
      action: "pack.joined",
      detail: { pack: res.packId, lead: res.leadMemberId, member: res.memberId, fingerprint: res.leadFingerprint },
    },
  };
}

// ── Rotation and revocation ──────────────────────────────────────────────────

/**
 * Reissue the pack secret (§8.4). **No grace window, no rollback secret** — the old value stops being
 * accepted the instant this lands, because a rotation that keeps honouring the leaked value for a
 * stated period has not rotated anything.
 *
 * Every member is left one generation behind; distribution then catches them up one at a time via
 * {@link markSecretDelivered}. Whoever is still behind when the operator calls the rotation done is
 * dropped by {@link dropMembersBehind}.
 */
export function rotatePackSecret(
  data: TrustStoreData,
  now: number,
  random: RandomSource = randomToken,
): PackChange<{ secretGeneration: number }> | null {
  if (data.pack === null) return null;
  const generation = data.pack.secretGeneration + 1;
  return {
    next: {
      ...data,
      pack: { ...data.pack, secret: random(32), secretGeneration: generation, rotatedAt: now },
    },
    result: { secretGeneration: generation },
    audit: { action: "pack.rotate", detail: { generation, members: data.peers.length } },
  };
}

/** Record that a member has taken the current secret — the per-member column `pack status` renders. */
export function markSecretDelivered(data: TrustStoreData, memberId: string): PackChange<null> | null {
  if (data.pack === null) return null;
  const generation = data.pack.secretGeneration;
  const found = data.peers.some((p) => p.memberId === memberId && p.secretGeneration !== generation);
  if (!found) return null;
  return {
    next: {
      ...data,
      peers: data.peers.map((p) => (p.memberId === memberId ? { ...p, secretGeneration: generation } : p)),
    },
    result: null,
    audit: { action: "pack.secret.delivered", detail: { member: memberId, generation } },
  };
}

/**
 * Close a rotation: every member that never picked up the current secret becomes `unenrolled`.
 *
 * They are marked, not deleted, so `pack status` can say *why* a machine went quiet and the operator
 * knows the recovery step is a fresh `collie join` rather than a network hunt (§8.4).
 */
export function dropMembersBehind(data: TrustStoreData): PackChange<{ dropped: string[] }> | null {
  if (data.pack === null) return null;
  const generation = data.pack.secretGeneration;
  const behind = data.peers.filter((p) => p.status === "enrolled" && p.secretGeneration !== generation);
  if (behind.length === 0) return null;
  return {
    next: {
      ...data,
      peers: data.peers.map((p) =>
        p.status === "enrolled" && p.secretGeneration !== generation ? { ...p, status: "unenrolled" as const } : p,
      ),
    },
    result: { dropped: behind.map((p) => p.memberId) },
    audit: { action: "pack.unenroll", detail: { members: behind.map((p) => p.memberId), generation } },
  };
}

/**
 * `collie pack remove <member>` on the lead: unpin and forget.
 *
 * The entry is **deleted**, not tombstoned. An `unenrolled` tombstone means "we still know this
 * machine and it may come back"; removal means the operator said otherwise, and keeping the pinned
 * fingerprint of a machine you have disowned is a pin waiting to be honoured by mistake.
 */
export function removeMember(data: TrustStoreData, memberId: string): PackChange<{ member: string }> | null {
  if (!data.peers.some((p) => p.memberId === memberId)) return null;
  return {
    next: { ...data, peers: data.peers.filter((p) => p.memberId !== memberId) },
    result: { member: memberId },
    audit: { action: "pack.remove", detail: { member: memberId } },
  };
}

/**
 * `collie leave` on a peer: drop the roster entry, the pinned material and the pack secret.
 *
 * This collie's **own** identity survives, so the operator can re-join without every other member
 * having to re-pin a new certificate. Either side alone ending the link is sufficient (§8.4) — the
 * lead's `pack remove` and this are independent, and a lost disk on one end is handled from the
 * other.
 */
export function leavePack(data: TrustStoreData): PackChange<{ pack: string | null }> | null {
  if (data.pack === null && data.lead === null && data.peers.length === 0 && data.invites.length === 0) {
    return null;
  }
  return {
    next: { ...data, pack: null, lead: null, peers: [], invites: [] },
    result: { pack: data.pack?.packId ?? null },
    audit: { action: "pack.leave", detail: { pack: data.pack?.packId, lead: data.lead?.memberId } },
  };
}

// ── Distribution, promotion and roaming ──────────────────────────────────────
//
// Everything below is driven by an OPERATOR VERB on one machine and lands on another over the pack
// link (`bridge/pack/router.ts`'s `secret` / `lead` / `leave` routes). They are transitions like the
// ones above and hold to the same rule: no clock, no entropy, no disk — the caller supplies `now`.

/**
 * One roster row as it travels between members during a promotion (§14).
 *
 * Every field is public by construction: a member id (§4: no routing information), the SHA-256 of a
 * certificate — a hash of a public document — and an address hint. Nothing secret rides this shape,
 * which is why a roster may be handed over an admitted link without becoming a second way to leak the
 * pack secret.
 */
export interface RosterEntry {
  readonly memberId: string;
  readonly fingerprint: string;
  /** The member's certificate, PEM — public material, and the only way the recipient can pin it. */
  readonly certPem: string;
  readonly address: string;
}

/** Project a pinned member down to the row that travels. Deliberately drops status and generation. */
export function rosterEntryOf(member: TrustedMember): RosterEntry {
  return {
    memberId: member.memberId,
    fingerprint: member.fingerprint,
    certPem: member.certPem,
    address: member.address,
  };
}

export function parseRosterEntry(value: unknown): RosterEntry | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const fingerprint = typeof v.fingerprint === "string" ? normalizeFingerprint(v.fingerprint) : null;
  if (!isMemberId(v.memberId) || fingerprint === null) return null;
  // Same cross-check as the enrollment payloads: a row whose certificate is not the one its
  // fingerprint names is refused outright rather than pinned in two disagreeing halves.
  if (typeof v.certPem !== "string" || fingerprintOfCert(v.certPem) !== fingerprint) return null;
  if (typeof v.address !== "string" || v.address.length === 0) return null;
  return { memberId: v.memberId, fingerprint, certPem: v.certPem, address: v.address };
}

export function parseRoster(value: unknown): RosterEntry[] | null {
  if (!Array.isArray(value)) return null;
  const out: RosterEntry[] = [];
  for (const row of value) {
    const entry = parseRosterEntry(row);
    if (entry === null) return null;
    out.push(entry);
  }
  return out;
}

/** Lift a roster row into a pinned member of this collie's own roster, at the current generation. */
function memberFrom(entry: RosterEntry, role: "lead" | "peer", generation: number, now: number): TrustedMember {
  return {
    memberId: entry.memberId,
    fingerprint: entry.fingerprint,
    certPem: entry.certPem,
    address: entry.address,
    role,
    status: "enrolled",
    enrolledAt: now,
    secretGeneration: generation,
    signedAt: 0,
  };
}

/** Is this collie leading? The roster's own answer, in the shape `deriveMode` reads it (mode.ts). */
export function isLeading(data: TrustStoreData): boolean {
  return data.lead === null && data.peers.length > 0;
}

/**
 * Peer side: adopt a rotated secret handed over by the lead (§8.4).
 *
 * Returns `null` — "nothing to do" — for a generation that is not ahead of the one already held, so a
 * redelivery is a no-op rather than a second write. **There is no grace window**: the previous secret
 * is replaced, not remembered, so the instant this lands the lead must already be presenting the new
 * one. That ordering is the distributing verb's job (`collie pack rotate` rotates locally FIRST and
 * dials with the superseded secret it still holds in memory), and it is why this function does not
 * try to keep both.
 */
export function adoptSecret(
  data: TrustStoreData,
  handover: { secret: string; generation: number },
  now: number,
): PackChange<{ secretGeneration: number }> | null {
  if (data.pack === null || data.lead === null) return null;
  if (handover.secret === "" || handover.generation <= data.pack.secretGeneration) return null;
  return {
    next: {
      ...data,
      pack: { ...data.pack, secret: handover.secret, secretGeneration: handover.generation, rotatedAt: now },
      lead: { ...data.lead, secretGeneration: handover.generation },
    },
    result: { secretGeneration: handover.generation },
    audit: { action: "pack.secret.adopted", detail: { generation: handover.generation, from: data.lead.memberId } },
  };
}

/**
 * Peer side: `lead` is the pack's lead from now on (§14) — re-pin it and dial it there instead.
 *
 * **A role change, not a re-enrollment**: the pack identity, the pack secret and this collie's own
 * member id are untouched, which is exactly what §14 promises and what makes promotion survivable
 * without a fresh token for every member. `peers` is emptied for the reason `acceptEnrollment` empties
 * it — a peer has no peers, and a store holding both resolves to the conflict mode.
 */
export function adoptLead(data: TrustStoreData, lead: RosterEntry, now: number): PackChange<{ lead: string }> | null {
  if (data.pack === null) return null;
  if (lead.memberId === data.self.memberId) return null;
  const already =
    data.lead !== null &&
    data.lead.memberId === lead.memberId &&
    data.lead.fingerprint === lead.fingerprint &&
    data.lead.address === lead.address &&
    data.lead.status === "enrolled";
  if (already) return null;
  return {
    next: {
      ...data,
      lead: memberFrom(lead, "lead", data.pack.secretGeneration, now),
      peers: [],
    },
    // A meaningful result, not `null`: `commitPackChange` collapses "no change" and "changed, with
    // nothing to report" into the same `null` at the call site, and the verbs branch on it.
    result: { lead: lead.memberId },
    audit: {
      action: "pack.lead.changed",
      detail: { lead: lead.memberId, fingerprint: lead.fingerprint, address: lead.address, from: data.lead?.memberId },
    },
  };
}

/**
 * Old lead side: step down for `newLead` and hand back the roster (§14).
 *
 * The roster travels because the new lead has to pin every remaining member and has no other way to
 * learn their fingerprints — and because §14 reuses existing pins rather than re-enrolling anybody.
 * The new lead is removed from the list it is handed: it is the recipient, not a member of its own
 * roster.
 *
 * Refuses (`null`) unless this collie really is the lead. A peer that is asked to demote has nothing
 * to hand over, and answering as though it did would let one peer's promotion rewrite another's.
 */
export function demoteSelf(
  data: TrustStoreData,
  newLead: RosterEntry,
  now: number,
): PackChange<{ roster: RosterEntry[] }> | null {
  if (data.pack === null || !isLeading(data)) return null;
  if (newLead.memberId === data.self.memberId) return null;
  const roster = data.peers
    .filter((p) => p.status === "enrolled" && p.memberId !== newLead.memberId)
    .map(rosterEntryOf);
  return {
    next: {
      ...data,
      lead: memberFrom(newLead, "lead", data.pack.secretGeneration, now),
      peers: [],
    },
    result: { roster },
    audit: { action: "pack.demote", detail: { lead: newLead.memberId, handed: roster.map((r) => r.memberId) } },
  };
}

/**
 * New lead side: take the crown (§14).
 *
 * `roster` is assembled by the verb, not derived here, because the two paths differ in exactly that
 * argument: a clean handover passes the demoted lead plus everyone it handed over, and `--force`
 * passes an empty list — the pack the operator can still reach is the pack they get, and every member
 * missing from it must `collie join` the new lead with a fresh token. Making the list an argument is
 * what keeps `--force` from being a second implementation of promotion.
 */
export function promoteSelf(
  data: TrustStoreData,
  roster: readonly RosterEntry[],
  now: number,
): PackChange<{ peers: string[] }> | null {
  if (data.pack === null) return null;
  const generation = data.pack.secretGeneration;
  const adopted = roster.filter((r) => r.memberId !== data.self.memberId);
  return {
    next: {
      ...data,
      lead: null,
      peers: adopted.map((r) => memberFrom(r, "peer", generation, now)),
      invites: [],
    },
    result: { peers: adopted.map((r) => r.memberId) },
    audit: {
      action: "pack.promote",
      detail: { pack: data.pack.packId, peers: adopted.map((r) => r.memberId), demoted: data.lead?.memberId },
    },
  };
}

/**
 * Advance a member's replay floor after a signed request was admitted (§8.6).
 *
 * Persisted **before the request is handled**, so a request that arrives twice cannot both be acted
 * on: the second one is refused by {@link timestampVerdict} against the floor the first one wrote.
 * A stale or equal timestamp is `null` — nothing to write, and the caller has already refused it.
 */
export function recordSignedRequest(
  data: TrustStoreData,
  memberId: string,
  timestamp: number,
): PackChange<{ signedAt: number }> | null {
  const bump = (m: TrustedMember): TrustedMember => ({ ...m, signedAt: timestamp });
  if (data.lead !== null && data.lead.memberId === memberId) {
    if (data.lead.signedAt >= timestamp) return null;
    return {
      next: { ...data, lead: bump(data.lead) },
      result: { signedAt: timestamp },
      audit: { action: "pack.signed", detail: { member: memberId, at: timestamp } },
    };
  }
  const peer = data.peers.find((p) => p.memberId === memberId);
  if (peer === undefined || peer.signedAt >= timestamp) return null;
  return {
    next: { ...data, peers: data.peers.map((p) => (p.memberId === memberId ? bump(p) : p)) },
    result: { signedAt: timestamp },
    audit: { action: "pack.signed", detail: { member: memberId, at: timestamp } },
  };
}

/**
 * `collie reconnect`: a member moved and is reachable somewhere else now.
 *
 * **The pin is untouched.** §4 is explicit that an address is a hint and the member id is the stable
 * thing; a laptop that changed networks has not changed certificate, so re-pinning here would turn
 * DHCP into a trust decision. Returns `null` when the address is already right — nothing to write.
 */
export function updateMemberAddress(
  data: TrustStoreData,
  memberId: string,
  address: string,
): PackChange<{ from: string }> | null {
  if (address === "") return null;
  if (data.lead !== null && data.lead.memberId === memberId) {
    if (data.lead.address === address) return null;
    return {
      next: { ...data, lead: { ...data.lead, address } },
      result: { from: data.lead.address },
      audit: { action: "pack.address", detail: { member: memberId, from: data.lead.address, to: address } },
    };
  }
  const peer = data.peers.find((p) => p.memberId === memberId);
  if (peer === undefined || peer.address === address) return null;
  return {
    next: {
      ...data,
      peers: data.peers.map((p) => (p.memberId === memberId ? { ...p, address } : p)),
    },
    result: { from: peer.address },
    audit: { action: "pack.address", detail: { member: memberId, from: peer.address, to: address } },
  };
}

// ── Committing ───────────────────────────────────────────────────────────────

/**
 * Apply a transition to the persisted store and record its audit line **after** the write lands.
 *
 * Ordering matters in exactly one direction: an audit line for a change that failed to persist is a
 * lie about the machine's state, whereas a persisted change whose audit line failed is a gap the
 * audit writer already tolerates by design (`bridge/audit.ts` never throws). So the write goes first.
 */
export async function commitPackChange<T>(
  store: TrustStore,
  audit: AuditLog | null,
  fn: (data: TrustStoreData | null) => PackChange<T> | null,
): Promise<T | null> {
  let recorded: AuditEntry | null = null;
  const result = await store.update((current) => {
    const change = fn(current);
    if (change === null) return null;
    recorded = change.audit;
    return { next: change.next, result: change.result };
  });
  if (recorded !== null) audit?.record(recorded);
  return result;
}

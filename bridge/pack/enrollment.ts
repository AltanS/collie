import type { AuditEntry, AuditLog } from "../audit.ts";
import {
  hashToken,
  isMemberId,
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

/** Mints {@link IdentityMaterial}. Injected — see {@link unmintableIdentity} for why it has to be. */
export type IdentityMinter = () => Promise<IdentityMaterial>;

/**
 * The default minter, which **refuses**.
 *
 * ── STUB, DELIBERATELY LOUD ──────────────────────────────────────────────────
 * Minting a self-signed X.509 certificate needs an ASN.1/DER encoder. Neither Bun nor Node ships one
 * (`node:crypto` can *parse* a certificate via `X509Certificate` and can generate a keypair, but it
 * cannot issue a certificate), and this repo has no dependency that can — verified against
 * `package.json`: `web-push` and `typescript` are the entire tree. Hand-rolling a DER encoder inside
 * a trust store is exactly the improvisation this spec's own overview rules out.
 *
 * So the *seam* ships and the *minting* does not. Everything downstream of the certificate — the
 * store shape, the pinning, the two-factor admission, the exchange, rotation, revocation — is real,
 * tested, and needs no change when a real minter lands. What must close it:
 *   • the spec that wires TLS supplies a real `IdentityMinter` and a `PeerFingerprintSource`
 *     (bridge/pack/admission.ts) that reads the fingerprint off the live TLS session;
 *   • M4/08's two-instance harness asserts a real handshake end to end.
 * Until then this throws with a message an operator can act on, rather than enrolling with a
 * placeholder certificate that would make an unpinnable link look pinned.
 */
export const unmintableIdentity: IdentityMinter = () => {
  return Promise.reject(
    new Error(
      "pack: cannot generate TLS identity material in this build — certificate minting is not wired yet " +
        "(PACK_PROTOCOL.md §8.1). Enrollment is refused rather than completed without a pinnable certificate.",
    ),
  );
};

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
 * invites are swept in the same pass, and an unmatched token still returns a `next` store — the
 * sweep is worth persisting even when nothing was spent.
 */
export function consumeInvite(
  data: TrustStoreData,
  token: string | null,
  now: number,
): PackChange<PendingInvite | null> {
  const live = data.invites.filter((i) => i.expiresAt > now);
  const hash = token === null ? null : hashToken(token);
  // Constant-time against every live invite: `find` on a plain === would leak, via timing, how many
  // invites are outstanding and how close a guess was.
  let matched: PendingInvite | null = null;
  for (const invite of live) {
    if (hash !== null && secretEquals(hash, invite.tokenHash)) matched = invite;
  }
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
  if (typeof v.address !== "string" || v.address.length === 0) return null;
  if (v.label !== null && v.label !== undefined && typeof v.label !== "string") return null;
  return {
    protocol: typeof v.protocol === "number" ? v.protocol : Number.NaN,
    token: v.token,
    fingerprint,
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
    fingerprint === null
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
  req: { fingerprint: string; address: string; label: string | null },
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
    address: req.address,
    role: "peer",
    status: "enrolled",
    enrolledAt: now,
    secretGeneration: data.pack.secretGeneration,
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
    address: leadAddress,
    role: "lead",
    status: "enrolled",
    enrolledAt: now,
    secretGeneration: res.secretGeneration,
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
export function removeMember(data: TrustStoreData, memberId: string): PackChange<null> | null {
  if (!data.peers.some((p) => p.memberId === memberId)) return null;
  return {
    next: { ...data, peers: data.peers.filter((p) => p.memberId !== memberId) },
    result: null,
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
export function leavePack(data: TrustStoreData): PackChange<null> | null {
  if (data.pack === null && data.lead === null && data.peers.length === 0 && data.invites.length === 0) {
    return null;
  }
  return {
    next: { ...data, pack: null, lead: null, peers: [], invites: [] },
    result: null,
    audit: { action: "pack.leave", detail: { pack: data.pack?.packId, lead: data.lead?.memberId } },
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

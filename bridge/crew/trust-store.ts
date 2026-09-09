import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "../json.ts";
import { isFingerprint, isMemberId } from "./identity.ts";
import { migrateCrewStateOnce } from "./state-migration.ts";
import type { Enrollment } from "./mode.ts";

// The trust store: the one file a crew member persists. It holds this collie's own identity and key
// material, the crew identity (including the crew secret), the pinned roster, and any enrollment
// invites the lead has minted but nobody has spent yet.
//
// ONE file, by requirement — an invite minted by `collie crew invite` in one process has to be
// spendable by the bridge in another, and splitting invites into a second file would mean two things
// to keep 0600, two things to write atomically, and two things to forget to delete on `leave`.
//
// At rest it follows the discipline `push-subscriptions.json` already uses and that this codebase
// treats as settled: atomic temp-file-then-rename, **file 0600 inside a 0700 directory**
// (`bridge/push.ts:186-192`), under `stateDir` (`bridge/config.ts:200-203`). It holds a private key
// and the crew secret, so it is strictly more sensitive than the precedent it copies.
//
// SOLO WRITES NOTHING. `load()` on an instance that never enrolled opens a file that isn't there and
// returns `null`: no directory is created, no key is generated, no default is materialised
// (CREW_PROTOCOL.md §11, "Files written"). Materialisation happens on the first *crew* action —
// minting an invite or answering one — and nowhere else.

/** The trust store's filename under `stateDir`. Also the literal the solo baseline scans for. */
export const TRUST_STORE_FILENAME = "crew-trust.json";

/** Absolute path of the trust store for a given state dir. The only place this path is composed. */
export function trustStorePath(stateDir: string): string {
  return join(stateDir, TRUST_STORE_FILENAME);
}

/**
 * On-disk schema version. Bumped only when a shape change cannot be read by the previous reader;
 * an unknown version is refused rather than guessed at, because guessing at a *trust* file's shape
 * is how a pin silently stops being enforced.
 */
export const TRUST_STORE_VERSION = 1;

/** This collie's own identity: the member id it answers to, and the certificate it presents. */
export interface SelfIdentity {
  readonly memberId: string;
  /** PEM of the self-signed certificate this collie presents on a crew link. */
  readonly certPem: string;
  /** PEM of the matching private key. The reason this file is 0600 and never leaves the machine. */
  readonly keyPem: string;
  /** SHA-256 of the certificate DER, lowercase hex — what the other side pins. */
  readonly fingerprint: string;
  readonly createdAt: number;
}

/** The crew this collie belongs to. Shared by every member; the secret is crew-wide (§8.1). */
export interface CrewIdentity {
  readonly crewId: string;
  /** Operator-chosen label, for `crew status` and the UI. Never an identifier. */
  readonly name: string;
  /** The crew-wide bearer secret. Rotated as one operation (§8.4). */
  readonly secret: string;
  /**
   * Which rotation the secret above belongs to. A member whose `secretGeneration` is behind this has
   * not picked up the current secret — that gap is exactly what `crew status` renders, and what
   * drops an offline member to `unenrolled` when a rotation completes.
   */
  readonly secretGeneration: number;
  readonly rotatedAt: number;
}

/** A member's status. `unenrolled` is a tombstone: known, remembered, and refused (§8.4). */
export type MemberStatus = "enrolled" | "unenrolled";

/**
 * One member of the crew, as this collie pins it.
 *
 * **Keyed by member id, not by address.** The address is a hint the lead dials and a roaming laptop
 * changes; the member id is the stable thing (CREW_PROTOCOL.md §4: "A member id … is not a hostname,
 * not an address, and carries no routing information"). Pinning per address would unpin a laptop
 * every time it moved networks, which is a trust decision made by DHCP.
 */
export interface TrustedMember {
  readonly memberId: string;
  /** The pinned certificate fingerprint. Pairwise: this is *our* pin of *them* (§8.1). */
  readonly fingerprint: string;
  /**
   * The pinned certificate itself, PEM.
   *
   * **The fingerprint is the pin; this is the material that lets the pin be *enforced*.** BoringSSL
   * verifies a peer's chain against a `ca` list of certificates, and Bun exposes no hook that pins by
   * fingerprint instead — so a store holding only a hash could compare pins it had no way to check.
   * It is also the public key §8.6's signatures are verified with. Storing it costs nothing in trust:
   * a certificate is a public document, and {@link TrustedMember.fingerprint} is derived from these
   * exact bytes, so the two can never disagree.
   */
  readonly certPem: string;
  /** Where this collie dials or expects the member. A hint — never an identity (§4). */
  readonly address: string;
  readonly role: "lead" | "peer";
  readonly status: MemberStatus;
  readonly enrolledAt: number;
  /** The secret generation this member is known to hold. Behind `crew.secretGeneration` = stale. */
  readonly secretGeneration: number;
  /**
   * First observed successful contact with this member.
   *
   * `null` = enrolled but never once contacted (provisional / a possible half-finished join). A
   * number = epoch ms of the first successful contact. **ABSENT (undefined)** = a member from before
   * this field existed — treated as already-contacted, never provisional (back-compat).
   */
  readonly contactedAt?: number | null;
  /**
   * The `X-Crew-Timestamp` of the last signed request this collie **admitted** from this member
   * (§8.6). `0` until one arrives.
   *
   * Persisted rather than held in memory because every membership verb restarts the bridge — a replay
   * window that reopens on restart is not a replay window at all.
   */
  readonly signedAt: number;
  /**
   * This member has not yet been told that the crown moved (RFC §7.1's partial success, §9's
   * reconciliation). Set on every member the takeover could not reach, cleared on the first contact
   * that lands the warrant.
   *
   * **OPTIONAL, and absent means CLOSED**: a member from before this field existed owes nothing, and
   * a store that never saw a takeover has no pending anybody. Persisted rather than held in memory
   * because the takeover RESTARTS this machine — an in-memory list would be lost at exactly the
   * moment it becomes the only record of what is left to do.
   */
  readonly rePinPending?: boolean;
}

/**
 * One roster row as it travels and as a deputy keeps it (RFC §7.4) — public material only: an id, a
 * fingerprint, the certificate behind it, and the address the operator typed.
 *
 * Structurally identical to `enrollment.ts`'s `RosterEntry`, which is the row §14.3's demotion
 * already returns. It is declared HERE because the trust store persists it and this module may not
 * import `enrollment.ts` (that one imports this).
 */
export interface RosterRow {
  readonly memberId: string;
  readonly fingerprint: string;
  readonly certPem: string;
  readonly address: string;
}

/**
 * An enrollment invite the lead has minted: single-use, short-lived (§8.2), and stored as a **hash**
 * so a trust store that leaks yields no spendable token.
 */
export interface PendingInvite {
  readonly tokenHash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** Operator's suggested label for the joining member. A hint for id minting, never binding. */
  readonly label: string | null;
}

/**
 * The operator's consent, on the lead, for ONE named member to take the crown (§14.1).
 *
 * **Not a secret and not a token.** The claim it authorises is already signature-authenticated
 * against a pinned certificate (§8.6), so consent only has to name *who* may take over — a leaked
 * trust store yields nothing spendable from this field, and nothing new crosses the wire.
 *
 * Ten minutes, single-use, at most one live at a time (minting replaces any prior), and swept lazily
 * exactly as an invite is: expired reads as absent, and the next write of this field drops it.
 */
export interface PendingHandover {
  /** Who may take over. The whole content of the consent. */
  readonly memberId: string;
  readonly createdAt: number;
  /** `createdAt` + 10 minutes (`HANDOVER_TTL_MS`). Past it, this record reads as absent. */
  readonly expiresAt: number;
}

/**
 * A standing, lead-signed permission for ONE member to take the crown (RFC §4.2, CREW_PROTOCOL.md
 * §18). Signed with the lead's own identity key and verified against the certificate the recipient
 * already pinned — no new key, no new algorithm, no CA (`bridge/crew/warrant.ts`).
 *
 * **The fingerprint is the load-bearing field.** A warrant naming only a member id would let anything
 * presenting that id be accepted; naming the fingerprint binds the certificate, so consent names the
 * *key* that may take over and not merely the name it answers to (§14.2's lesson).
 */
export interface Warrant {
  readonly crewId: string;
  /** Monotonic on the lead. Higher supersedes lower, everywhere. Never reset, never reused. */
  readonly generation: number;
  /** The deputy, or `null` — a revocation warrant names nobody (RFC §4.4). */
  readonly deputyMemberId: string | null;
  /** The deputy's pinned certificate fingerprint. `null` iff `deputyMemberId` is null. */
  readonly deputyFingerprint: string | null;
  /** The issuing lead's member id — so a verifier knows whose key to check it with. */
  readonly leadMemberId: string;
  /** When this GENERATION was minted. Does not move on a refresh. */
  readonly issuedAt: number;
  /**
   * When this generation was last re-signed by a healthy lead (RFC §4.5). The warrant is dead at
   * `refreshedAt + WARRANT_TTL_MS`. On a fresh mint, equal to `issuedAt`.
   */
  readonly refreshedAt: number;
  /** Base64 ECDSA-P256-SHA256 over `canonicalWarrant` (`bridge/crew/warrant.ts`). */
  readonly signature: string;
}

/**
 * The warrant as a member keeps it, with the material that came with it.
 *
 * **A peer has no roster beyond its lead**, so it cannot look the deputy's certificate up — the push
 * carries it and the peer accepts it only when `sha256(certPem)` equals the warrant's
 * `deputyFingerprint` (RFC §5, the identical rule §8.2 uses at enrollment). Without those bytes a
 * peer could never build the second TLS anchor, because BoringSSL anchors on certificates and not on
 * hashes.
 */
export interface StoredWarrant {
  readonly warrant: Warrant;
  /**
   * The deputy's certificate, PEM. `null` on a revocation warrant (nobody is named) and on the
   * issuing lead itself, which pins the deputy in its own roster and needs no copy.
   */
  readonly deputyCertPem: string | null;
}

/** The whole file. */
export interface TrustStoreData {
  readonly version: number;
  readonly self: SelfIdentity;
  readonly crew: CrewIdentity | null;
  /** The lead that enrolled this collie, when this collie is a peer. */
  readonly lead: TrustedMember | null;
  /** Peers this collie leads. */
  readonly peers: readonly TrustedMember[];
  readonly invites: readonly PendingInvite[];
  /**
   * The live handover approval, when the operator has armed one here (§14.1). Sibling to `invites`
   * because it is the same kind of thing: short-lived, single-use, minted by an operator verb.
   *
   * **OPTIONAL, and absent means CLOSED.** A store written before this field existed has no approval,
   * so an unamended lead upgrades into *refusing* a promotion rather than accepting one — the
   * fail-closed reading has to hold through the parser as well as through the transition, which is
   * why {@link parseTrustStore}'s whitelist names it in both the validator and the result.
   */
  readonly pendingHandover?: PendingHandover | null;
  /**
   * On the LEAD: the member the operator has designated as deputy, or `null` after a revocation
   * (RFC §3). It is the operator's *designation*; {@link TrustStoreData.warrant} is the signed
   * artefact of it, and the two are written in one step so they can never disagree.
   *
   * **OPTIONAL, and absent means CLOSED** — a store written before this field existed has designated
   * nobody, which is exactly the right reading. A peer never writes this field: what a peer holds is
   * the warrant, and the deputy's name is inside it.
   */
  readonly deputy?: string | null;
  /**
   * The one warrant this collie holds (RFC §4.4: the highest generation it has verified, and within
   * that generation the highest `refreshedAt`). On the lead, the warrant it currently issues; on a
   * peer, the one its lead last pushed.
   *
   * **OPTIONAL, and absent means CLOSED** — no warrant, therefore no deputy, therefore nothing
   * eligible to take over. It also carries the generation counter, which is why a *revocation*
   * (generation N+1 naming nobody) is stored rather than deleted: dropping the field would reset the
   * counter and make an old warrant verify again (RFC §4.4).
   */
  readonly warrant?: StoredWarrant | null;
  /**
   * On the DEPUTY: the lead's roster as of the last warrant push (RFC §7.4).
   *
   * The signed warrant carries no roster and that stands — this rides **beside** it, on the same
   * push, to the deputy and to nobody else. A deputy holds exactly one roster entry of its own (its
   * lead), so without this a takeover would be a takeover into a crew it cannot see. It is not
   * signed, because it does not need to be: it arrives over a two-factor crew link from the pinned
   * lead, which is the trust basis every other lead→peer byte already has.
   *
   * **OPTIONAL, and absent means CLOSED** — no roster, so RFC §7's step (c) refuses rather than
   * inventing one. Refreshed on change, because a stale roster on a deputy is a takeover into a crew
   * it cannot see either.
   */
  readonly standbyRoster?: readonly RosterRow[] | null;
  /**
   * When a takeover **spent** this collie's designation — the instant this machine became the lead
   * by taking over, rather than by being promoted or by enrolling the first peer (RFC §7.1's (c)).
   *
   * It exists because the state a takeover leaves behind is otherwise indistinguishable from two
   * innocent ones. The new lead keeps the WARRANT (it carries the generation counter, which must
   * never reset, and it is the proof handed to every member that was down) — and that warrant names
   * **this machine**. A surface reading the deputy off the warrant therefore reports a lead as its
   * own deputy, which is what the live drill saw. `deputy: null` says nobody is designated; this says
   * *why*, so `crew status` can name the follow-up (RFC §14.4's first) instead of a bare absence.
   *
   * **OPTIONAL, and absent means CLOSED** — no takeover has happened here, which is the right
   * reading for every store written before this field existed and for every lead that never took
   * over. Cleared the moment a new deputy is designated, because the question it answers ("why does
   * this lead name nobody?") no longer applies.
   */
  readonly deputySpentAt?: number | null;
}

/**
 * The projection `deriveMode` consumes (bridge/crew/mode.ts). Narrowing here rather than handing the
 * whole store to the mode function is deliberate: mode must stay a decision about the roster, so it
 * is given the roster and nothing it could accidentally start branching on.
 */
export function enrollmentOf(data: TrustStoreData | null): Enrollment | null {
  if (data === null) return null;
  return {
    peers: data.peers.filter((p) => p.status === "enrolled").map((p) => ({ memberId: p.memberId })),
    lead: data.lead !== null && data.lead.status === "enrolled" ? { memberId: data.lead.memberId } : null,
  };
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/** A serialised record, or null when the value isn't one. Arrays are records to `typeof`, not here. */
function asRecord(value: JsonValue | undefined): JsonObject | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

function isMember(value: JsonValue | undefined): value is JsonValue & TrustedMember {
  const m = asRecord(value);
  if (m === null) return false;
  return (
    isMemberId(m.memberId) &&
    isFingerprint(m.fingerprint) &&
    typeof m.certPem === "string" &&
    m.certPem.includes("BEGIN CERTIFICATE") &&
    typeof m.address === "string" &&
    (m.role === "lead" || m.role === "peer") &&
    (m.status === "enrolled" || m.status === "unenrolled") &&
    typeof m.enrolledAt === "number" &&
    typeof m.secretGeneration === "number" &&
    typeof m.signedAt === "number" &&
    // Accept the optional field without newly requiring it. CRITICAL back-compat rule: provisional is
    // STRICTLY `contactedAt === null`. An absent field is `undefined`, which must NEVER read as
    // provisional — otherwise every member enrolled before this field existed (the live crew) would
    // regress to "provisional" on upgrade.
    (m.contactedAt === undefined || m.contactedAt === null || typeof m.contactedAt === "number") &&
    // Same back-compat rule, same reason: absent is "owes nothing", never "pending".
    (m.rePinPending === undefined || typeof m.rePinPending === "boolean")
  );
}

/** One roster row, structurally. The cross-check `fingerprint === sha256(certPem)` is the wire's. */
function isRosterRow(value: JsonValue | undefined): value is JsonValue & RosterRow {
  const r = asRecord(value);
  if (r === null) return false;
  return (
    isMemberId(r.memberId) &&
    isFingerprint(r.fingerprint) &&
    typeof r.certPem === "string" &&
    r.certPem.includes("BEGIN CERTIFICATE") &&
    typeof r.address === "string"
  );
}

/** The deputy's copy of its lead's roster (RFC §7.4). A malformed row invalidates the whole store. */
function isStandbyRoster(value: JsonValue | undefined): value is JsonValue & RosterRow[] {
  return Array.isArray(value) && value.every(isRosterRow);
}

function isInvite(value: JsonValue | undefined): value is JsonValue & PendingInvite {
  const i = asRecord(value);
  if (i === null) return false;
  return (
    typeof i.tokenHash === "string" &&
    i.tokenHash.length > 0 &&
    typeof i.createdAt === "number" &&
    typeof i.expiresAt === "number" &&
    (i.label === null || typeof i.label === "string")
  );
}

function isHandover(value: JsonValue | undefined): value is JsonValue & PendingHandover {
  const h = asRecord(value);
  if (h === null) return false;
  return isMemberId(h.memberId) && typeof h.createdAt === "number" && typeof h.expiresAt === "number";
}

/**
 * A stored warrant, structurally (RFC §4.2).
 *
 * The two `null`-together fields are checked as a pair rather than separately: `deputyMemberId` and
 * `deputyFingerprint` are null in a revocation warrant and both present otherwise, and a half-named
 * deputy is not a shape this codebase should have to reason about downstream. Nothing here checks the
 * *signature* — that needs a certificate the parser does not have, and it is the verifier's job
 * (`bridge/crew/warrant.ts`), which is where the fail-closed reading lives.
 */
function isWarrant(value: JsonValue | undefined): value is JsonValue & Warrant {
  const w = asRecord(value);
  if (w === null) return false;
  const named = isMemberId(w.deputyMemberId) && isFingerprint(w.deputyFingerprint);
  const revoked = w.deputyMemberId === null && w.deputyFingerprint === null;
  return (
    // REMOVE_IN_1_9_0: `packId` is the 1.7.0 spelling of `crewId`. A store written by 1.7.0 holds a
    // warrant under the old key, and {@link storedWarrantCrewId} is what puts the value under the new
    // one — this guard only has to accept either, or the whole store reads as malformed.
    typeof warrantCrewId(w) === "string" &&
    typeof w.generation === "number" &&
    Number.isSafeInteger(w.generation) &&
    (named || revoked) &&
    isMemberId(w.leadMemberId) &&
    typeof w.issuedAt === "number" &&
    typeof w.refreshedAt === "number" &&
    typeof w.signature === "string" &&
    w.signature.length > 0
  );
}

/** A finite epoch-millisecond stamp, at the optional reader's argument type. */
function isTimestamp(value: JsonValue | undefined): value is JsonValue & number {
  return typeof value === "number" && Number.isFinite(value);
}

/** {@link isMemberId} at this parser's argument type, so the optional reader below can take it. */
function isDeputyId(value: JsonValue | undefined): value is JsonValue & string {
  return isMemberId(value);
}

/**
 * REMOVE_IN_1_9_0 — the warrant's crew id, under either spelling (§0.1).
 *
 * The warrant is one signature that lives on every member's disk and travels the wire, so a machine
 * that updates from 1.7.0 comes up holding one written under `packId`. Every 1.8.0 WRITER emits
 * `crewId`; every 1.8.0 READER accepts both, and this is the one place that decides which.
 *
 * `undefined` when neither is a string, which is what makes the guard above refuse the store.
 */
function warrantCrewId(w: JsonObject): JsonValue | undefined {
  return typeof w.crewId === "string" ? w.crewId : w.packId;
}

/**
 * REMOVE_IN_1_9_0 — a stored warrant with its crew id moved to the crew spelling.
 *
 * The guard accepts either key, but the value handed downstream must carry `crewId`, or a 1.7.0 blob
 * would satisfy the type and read `undefined` at every use. The next write puts the crew spelling on
 * disk, so a store is converted by being read once.
 *
 * `raw` is the same field before narrowing, so the old key is read as JSON rather than asserted
 * through the type — the guard already proved one of the two is a string.
 */
function storedWarrantCrewId(stored: StoredWarrant | null, raw: JsonValue | undefined): StoredWarrant | null {
  if (stored === null || typeof stored.warrant.crewId === "string") return stored;
  const legacy = asRecord(asRecord(raw)?.warrant);
  const crewId = legacy === null ? undefined : legacy.packId;
  if (typeof crewId !== "string") return stored;
  // Field by field rather than a spread: a spread would keep the dead `packId` beside the new key,
  // and the next write would put BOTH on disk — a store that migrates for ever.
  const w = stored.warrant;
  return {
    ...stored,
    warrant: {
      crewId,
      generation: w.generation,
      deputyMemberId: w.deputyMemberId,
      deputyFingerprint: w.deputyFingerprint,
      leadMemberId: w.leadMemberId,
      issuedAt: w.issuedAt,
      refreshedAt: w.refreshedAt,
      signature: w.signature,
    },
  };
}

function isStoredWarrant(value: JsonValue | undefined): value is JsonValue & StoredWarrant {
  const s = asRecord(value);
  if (s === null) return false;
  if (!isWarrant(s.warrant)) return false;
  return (
    s.deputyCertPem === null ||
    (typeof s.deputyCertPem === "string" && s.deputyCertPem.includes("BEGIN CERTIFICATE"))
  );
}

/**
 * Read one OPTIONAL top-level field, keeping the absent/`null` distinction intact.
 *
 * Three fields now need the identical three-way reading — absent, explicitly null, or a value that
 * must validate — and the rule they share is the one that is easy to get wrong: **absent must stay
 * absent**, so a store written before the field existed round-trips to the same bytes it arrived as,
 * and anything malformed invalidates the WHOLE store rather than being read around.
 *
 * `null` is the refusal (malformed); a box is the answer, so `undefined` inside it is a value.
 */
function optionalField<T>(
  raw: JsonValue | undefined,
  is: (value: JsonValue | undefined) => value is JsonValue & T,
): { readonly value: T | null | undefined } | null {
  if (raw === null || raw === undefined) return { value: raw };
  return is(raw) ? { value: raw } : null;
}

/**
 * Parse a trust store from its serialised form. Returns `null` for anything that isn't a store this
 * reader understands — a wrong version, a missing identity, a member with an unpinnable fingerprint.
 *
 * **Refusing beats repairing.** A partially-read trust file is a roster with a hole in it, and a hole
 * in a roster is an unpinned member. The caller surfaces the refusal (the bridge still starts; a
 * peer's own operator is never locked out of their machine by a bad roster) rather than writing a
 * "fixed" store back over the operator's file.
 */
export function parseTrustStore(raw: string): TrustStoreData | null {
  let value: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction. Naming it here is what makes every
    // field read below a checked property access instead of an assertion through `unknown`.
    value = JSON.parse(raw) as JsonValue;
  } catch {
    return null;
  }
  const d = asRecord(value);
  if (d === null) return null;
  if (d.version !== TRUST_STORE_VERSION) return null;

  const self = asRecord(d.self);
  if (
    self === null ||
    !isMemberId(self.memberId) ||
    typeof self.certPem !== "string" ||
    typeof self.keyPem !== "string" ||
    !isFingerprint(self.fingerprint) ||
    typeof self.createdAt !== "number"
  ) {
    return null;
  }

  // REMOVE_IN_1_9_0: `pack`/`crewId` are the 1.7.0 spellings of `crew`/`crewId`. Read once here,
  // written back in the crew spelling by the next `update` — a 1.7.0 store therefore needs no
  // separate rewrite step, and a 1.8.0 store is never read by the old key at all.
  const crewField = d.crew ?? d.pack;
  let crew: CrewIdentity | null = null;
  if (crewField !== null && crewField !== undefined) {
    const p = asRecord(crewField);
    const crewId = p === null ? undefined : (p.crewId ?? p.packId);
    if (
      p === null ||
      typeof crewId !== "string" ||
      typeof p.name !== "string" ||
      typeof p.secret !== "string" ||
      typeof p.secretGeneration !== "number" ||
      typeof p.rotatedAt !== "number"
    ) {
      return null;
    }
    crew = {
      crewId,
      name: p.name,
      secret: p.secret,
      secretGeneration: p.secretGeneration,
      rotatedAt: p.rotatedAt,
    };
  }

  // `null`/absent lead is the ordinary peerless case; anything else must be a whole member.
  let lead: TrustedMember | null = null;
  if (d.lead !== null && d.lead !== undefined) {
    if (!isMember(d.lead)) return null;
    lead = d.lead;
  }
  if (!Array.isArray(d.peers) || !d.peers.every(isMember)) return null;
  if (!Array.isArray(d.invites) || !d.invites.every(isInvite)) return null;
  // Same strictness the roster gets: a malformed approval, designation or warrant invalidates the
  // WHOLE store rather than being read around. Absent or `null` is the ordinary, fail-closed case —
  // no live approval, no deputy, no warrant. The two are NOT collapsed: `null` round-trips as `null`,
  // absent round-trips as absent.
  const handover = optionalField(d.pendingHandover, isHandover);
  const deputy = optionalField<string>(d.deputy, isDeputyId);
  const warrant = optionalField(d.warrant, isStoredWarrant);
  const standbyRoster = optionalField<RosterRow[]>(d.standbyRoster, isStandbyRoster);
  const spentAt = optionalField<number>(d.deputySpentAt, isTimestamp);
  if (handover === null || deputy === null || warrant === null || standbyRoster === null || spentAt === null) {
    return null;
  }

  const store: TrustStoreData = {
    version: TRUST_STORE_VERSION,
    self: {
      memberId: self.memberId,
      certPem: self.certPem,
      keyPem: self.keyPem,
      fingerprint: self.fingerprint,
      createdAt: self.createdAt,
    },
    crew,
    lead,
    peers: d.peers,
    invites: d.invites,
  };
  // THE WHITELIST IS THE TRAP: the literal above is the store, so a field validated but left out of
  // it vanishes on every load→save round trip — and an approval that cannot survive a read is an
  // approval the demotion can never find (§14.1); a warrant that cannot survive one is a deputy that
  // silently stops existing at the next write. Absent stays absent rather than becoming an explicit
  // `null`, so a pre-amendment store round-trips to the same bytes it arrived as.
  let out = store;
  if (handover.value !== undefined) out = { ...out, pendingHandover: handover.value };
  if (deputy.value !== undefined) out = { ...out, deputy: deputy.value };
  // REMOVE_IN_1_9_0: `storedWarrantCrewId` moves a 1.7.0 `packId` onto `crewId`.
  if (warrant.value !== undefined) out = { ...out, warrant: storedWarrantCrewId(warrant.value, d.warrant) };
  if (standbyRoster.value !== undefined) out = { ...out, standbyRoster: standbyRoster.value };
  if (spentAt.value !== undefined) out = { ...out, deputySpentAt: spentAt.value };
  return out;
}

/** Serialise a store for disk. Stable, pretty-printed, newline-terminated — a diffable secret file. */
export function serializeTrustStore(data: TrustStoreData): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

// ── The file ─────────────────────────────────────────────────────────────────

/** The filesystem operations the store needs, injected so the logic is testable without a disk. */
export interface TrustStoreIo {
  /** Read the file, or `null` when it does not exist. Any other error propagates. */
  read(path: string): Promise<string | null>;
  /** Atomically replace the file with `data`, creating its directory 0700 and the file 0600. */
  write(path: string, data: string): Promise<void>;
}

/**
 * The real filesystem, with the 0600/0700 + temp-and-rename discipline `push.ts` established.
 *
 * REMOVE_IN_1_9_0: each operation below first runs the one-time move of 1.7.0's `pack-*.json` names
 * ({@link migrateCrewStateOnce}).
 *
 * ON THE OPERATION, NOT ON THE FACTORY, and not at a process entry either. Both of those were tried
 * during M27 and both moved an operator's live files: a factory runs when a CLI verb builds its deps
 * (`collie crew --help` builds them and opens nothing), and a process entry runs for every verb,
 * including one invoked under `env -i` with no HOME. Here it runs exactly when this collie is about
 * to read or write the directory, which is the moment the old name has to be gone. A test injects
 * its own {@link TrustStoreIo}, so no test reaches it at all.
 */
export function fsTrustStoreIo(stateDir: string): TrustStoreIo {
  const migrate = () => migrateCrewStateOnce(stateDir, (line) => console.warn(line));
  return {
    async read(path) {
      migrate();
      try {
        return await readFile(path, "utf8");
      } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
        throw err;
      }
    },
    async write(path, data) {
      migrate();
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const tmp = `${path}.tmp`;
      // Mode on create — the temp file is 0600 from the instant it exists, so the private key is
      // never briefly world-readable between write and chmod.
      await writeFile(tmp, data, { mode: 0o600 });
      await rename(tmp, path);
    },
  };
}

/**
 * The trust store as the process holds it: a cached read, a serialised write, and no ambient state.
 *
 * Writes funnel through one chain for the same reason `Push` does it (`bridge/push.ts:175-184`):
 * concurrent saves must not interleave, and one failed write must not wedge the next. Unlike `Push`,
 * a failed write here is **not** swallowed at the call site — losing a pin is a security event, so
 * the promise rejects and the caller decides.
 */
export class TrustStore {
  private cached: TrustStoreData | null = null;
  private loaded = false;
  private writeChain: Promise<unknown> = Promise.resolve();
  private readonly path: string;

  constructor(
    stateDir: string,
    private readonly io: TrustStoreIo = fsTrustStoreIo(stateDir),
  ) {
    this.path = trustStorePath(stateDir);
  }

  /**
   * The store's contents, or `null` when this collie has never enrolled.
   *
   * Reads at most once per process; the process is the only writer, so a re-read would only be
   * defending against an operator hand-editing a 0600 file under a running bridge.
   */
  async load(): Promise<TrustStoreData | null> {
    if (this.loaded) return this.cached;
    const raw = await this.io.read(this.path);
    this.cached = raw === null ? null : parseTrustStore(raw);
    if (raw !== null && this.cached === null) {
      console.warn(
        `[crew] ${this.path} is not a trust store this build can read — staying solo and touching nothing. ` +
          `Fix or remove the file; it has NOT been overwritten.`,
      );
    }
    this.loaded = true;
    return this.cached;
  }

  /** The last loaded value without touching the disk. `null` before {@link load} has been called. */
  current(): TrustStoreData | null {
    return this.cached;
  }

  /**
   * Apply a pure transition to the store and persist the result.
   *
   * Every mutation in this module goes through here, which is what keeps the transitions themselves
   * (enrollment.ts) pure functions over data: they never learn there is a disk. `mutate` returning
   * `null` means "no change" and writes nothing.
   */
  async update<T>(fn: (current: TrustStoreData | null) => { next: TrustStoreData; result: T } | null): Promise<T | null> {
    const run = async (): Promise<T | null> => {
      await this.load();
      const outcome = fn(this.cached);
      if (outcome === null) return null;
      await this.io.write(this.path, serializeTrustStore(outcome.next));
      this.cached = outcome.next;
      return outcome.result;
    };
    const chained = this.writeChain.then(run, run);
    // The chain itself must not carry the rejection forward — one failed update must not poison the
    // next — but the value handed to THIS caller keeps it.
    this.writeChain = chained.catch(() => {});
    return chained;
  }
}

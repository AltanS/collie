import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isFingerprint, isMemberId } from "./identity.ts";
import type { Enrollment } from "./mode.ts";

// The trust store: the one file a pack member persists. It holds this collie's own identity and key
// material, the pack identity (including the pack secret), the pinned roster, and any enrollment
// invites the lead has minted but nobody has spent yet.
//
// ONE file, by requirement — an invite minted by `collie pack invite` in one process has to be
// spendable by the bridge in another, and splitting invites into a second file would mean two things
// to keep 0600, two things to write atomically, and two things to forget to delete on `leave`.
//
// At rest it follows the discipline `push-subscriptions.json` already uses and that this codebase
// treats as settled: atomic temp-file-then-rename, **file 0600 inside a 0700 directory**
// (`bridge/push.ts:186-192`), under `stateDir` (`bridge/config.ts:200-203`). It holds a private key
// and the pack secret, so it is strictly more sensitive than the precedent it copies.
//
// SOLO WRITES NOTHING. `load()` on an instance that never enrolled opens a file that isn't there and
// returns `null`: no directory is created, no key is generated, no default is materialised
// (PACK_PROTOCOL.md §11, "Files written"). Materialisation happens on the first *pack* action —
// minting an invite or answering one — and nowhere else.

/** The trust store's filename under `stateDir`. Also the literal the solo baseline scans for. */
export const TRUST_STORE_FILENAME = "pack-trust.json";

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
  /** PEM of the self-signed certificate this collie presents on a pack link. */
  readonly certPem: string;
  /** PEM of the matching private key. The reason this file is 0600 and never leaves the machine. */
  readonly keyPem: string;
  /** SHA-256 of the certificate DER, lowercase hex — what the other side pins. */
  readonly fingerprint: string;
  readonly createdAt: number;
}

/** The pack this collie belongs to. Shared by every member; the secret is pack-wide (§8.1). */
export interface PackIdentity {
  readonly packId: string;
  /** Operator-chosen label, for `pack status` and the UI. Never an identifier. */
  readonly name: string;
  /** The pack-wide bearer secret. Rotated as one operation (§8.4). */
  readonly secret: string;
  /**
   * Which rotation the secret above belongs to. A member whose `secretGeneration` is behind this has
   * not picked up the current secret — that gap is exactly what `pack status` renders, and what
   * drops an offline member to `unenrolled` when a rotation completes.
   */
  readonly secretGeneration: number;
  readonly rotatedAt: number;
}

/** A member's status. `unenrolled` is a tombstone: known, remembered, and refused (§8.4). */
export type MemberStatus = "enrolled" | "unenrolled";

/**
 * One member of the pack, as this collie pins it.
 *
 * **Keyed by member id, not by address.** The address is a hint the lead dials and a roaming laptop
 * changes; the member id is the stable thing (PACK_PROTOCOL.md §4: "A member id … is not a hostname,
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
  /** The secret generation this member is known to hold. Behind `pack.secretGeneration` = stale. */
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
   * The `X-Pack-Timestamp` of the last signed request this collie **admitted** from this member
   * (§8.6). `0` until one arrives.
   *
   * Persisted rather than held in memory because every membership verb restarts the bridge — a replay
   * window that reopens on restart is not a replay window at all.
   */
  readonly signedAt: number;
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

/** The whole file. */
export interface TrustStoreData {
  readonly version: number;
  readonly self: SelfIdentity;
  readonly pack: PackIdentity | null;
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
}

/**
 * The projection `deriveMode` consumes (bridge/pack/mode.ts). Narrowing here rather than handing the
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

function isMember(value: unknown): value is TrustedMember {
  if (value === null || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
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
    // provisional — otherwise every member enrolled before this field existed (the live pack) would
    // regress to "provisional" on upgrade.
    (m.contactedAt === undefined || m.contactedAt === null || typeof m.contactedAt === "number")
  );
}

function isInvite(value: unknown): value is PendingInvite {
  if (value === null || typeof value !== "object") return false;
  const i = value as Record<string, unknown>;
  return (
    typeof i.tokenHash === "string" &&
    i.tokenHash.length > 0 &&
    typeof i.createdAt === "number" &&
    typeof i.expiresAt === "number" &&
    (i.label === null || typeof i.label === "string")
  );
}

function isHandover(value: unknown): value is PendingHandover {
  if (value === null || typeof value !== "object") return false;
  const h = value as Record<string, unknown>;
  return isMemberId(h.memberId) && typeof h.createdAt === "number" && typeof h.expiresAt === "number";
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
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const d = value as Record<string, unknown>;
  if (d.version !== TRUST_STORE_VERSION) return null;

  const self = d.self as Record<string, unknown> | undefined;
  if (
    !self ||
    !isMemberId(self.memberId) ||
    typeof self.certPem !== "string" ||
    typeof self.keyPem !== "string" ||
    !isFingerprint(self.fingerprint) ||
    typeof self.createdAt !== "number"
  ) {
    return null;
  }

  let pack: PackIdentity | null = null;
  if (d.pack !== null && d.pack !== undefined) {
    const p = d.pack as Record<string, unknown>;
    if (
      typeof p.packId !== "string" ||
      typeof p.name !== "string" ||
      typeof p.secret !== "string" ||
      typeof p.secretGeneration !== "number" ||
      typeof p.rotatedAt !== "number"
    ) {
      return null;
    }
    pack = {
      packId: p.packId,
      name: p.name,
      secret: p.secret,
      secretGeneration: p.secretGeneration,
      rotatedAt: p.rotatedAt,
    };
  }

  if (d.lead !== null && d.lead !== undefined && !isMember(d.lead)) return null;
  if (!Array.isArray(d.peers) || !d.peers.every(isMember)) return null;
  if (!Array.isArray(d.invites) || !d.invites.every(isInvite)) return null;
  // Same strictness the roster gets: a malformed approval invalidates the WHOLE store rather than
  // being read around. Absent or `null` is the ordinary, fail-closed case — no live approval.
  const handover = d.pendingHandover;
  if (handover !== null && handover !== undefined && !isHandover(handover)) return null;

  return {
    version: TRUST_STORE_VERSION,
    self: {
      memberId: self.memberId,
      certPem: self.certPem,
      keyPem: self.keyPem,
      fingerprint: self.fingerprint,
      createdAt: self.createdAt,
    },
    pack,
    lead: (d.lead as TrustedMember | undefined) ?? null,
    peers: d.peers,
    invites: d.invites,
    // THE WHITELIST IS THE TRAP: this literal is the store, so a field validated above and left out
    // here vanishes on every load→save round trip — and an approval that cannot survive a read is an
    // approval the demotion can never find (§14.1). Absent stays absent rather than becoming an
    // explicit `null`, so a pre-amendment store round-trips to the same bytes it arrived as.
    ...(handover === undefined ? {} : { pendingHandover: handover }),
  };
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

/** The real filesystem, with the 0600/0700 + temp-and-rename discipline `push.ts` established. */
export function fsTrustStoreIo(stateDir: string): TrustStoreIo {
  return {
    async read(path) {
      try {
        return await readFile(path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async write(path, data) {
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
        `[pack] ${this.path} is not a trust store this build can read — staying solo and touching nothing. ` +
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

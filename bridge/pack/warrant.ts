import type { JsonObject, JsonValue } from "../json.ts";
import { parseRoster, type PackChange } from "./enrollment.ts";
import { fingerprintOfCert, isFingerprint, isMemberId, normalizeFingerprint } from "./identity.ts";
import { signCanonical, verifyCanonical } from "./signing.ts";
import type { RosterRow, StoredWarrant, TrustStoreData, Warrant } from "./trust-store.ts";

// The warrant: the lead's standing, signed permission for ONE member to take the crown
// (PACK_PROTOCOL.md §18, RFC §4). This module mints it, verifies it, and decides what supersedes
// what. It does not distribute it — that is `peer-client.ts` (the push) and `lead.ts` (the sweep) —
// and it does not spend it: holding a warrant grants nothing on its own.
//
// ── NO NEW CRYPTO ────────────────────────────────────────────────────────────
// Base64 ECDSA-P256-SHA256 over a canonical string, made with `SelfIdentity.keyPem` and verified
// against a certificate the verifier ALREADY PINNED (`signing.ts`'s two primitives, unchanged). No
// new key, no new algorithm, no new trust anchor, no CA. A peer verifying a warrant is asking the one
// question it can already answer: *did the member we pinned as our lead sign this?*
//
// PURE BY CONSTRUCTION, like `enrollment.ts`: every function here is a function of data. Nothing
// reads a clock, a disk or a request — the caller supplies `now` and the caller writes the store.

/**
 * The fixed domain tag, and the first field of every canonical warrant string.
 *
 * §8.6's request string has four fields and §16 reserves a five-field handover string, and both rely
 * on **field-count disjointness** so the two can never verify as one another under a key that is
 * genuinely shared (a lead signs `hello` probes, `leave`, `lead` *and* warrants with one private
 * key). That property is real but it degrades with every signed object added. A fixed tag makes the
 * disjointness **structural rather than arithmetic**, and costs one string (RFC §4.3).
 */
export const WARRANT_DOMAIN = "collie-pack-warrant-v1";

/**
 * How long a warrant lives **from its last refresh** — not from its issue (RFC §4.5).
 *
 * An expiry measured from issue expires precisely when it is needed: the lead is the only party that
 * can re-issue one, so an operator whose lead died on holiday would find the deputy disarmed at the
 * one moment it mattered. Measured from the last refresh, the warrant is only ever as old as the last
 * time the pack was healthy — a pack in daily use never approaches it, and a pack that has been dark
 * for a month disarms itself.
 */
export const WARRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How often a healthy lead re-signs the current generation (RFC §4.5).
 *
 * Re-signing is one ECDSA operation over ~150 bytes and is not worth optimising; the **push** is. A
 * peer already holding this generation at this refresh is not re-pushed, so the steady-state wire
 * cost is one small body per member per hour rather than one per sweep — which is the whole reason
 * this interval exists rather than "every sweep".
 */
export const WARRANT_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/** The literal that stands in for a null deputy field, so two different warrants never share a string. */
const NONE = "-";

/**
 * The string that is signed, exactly (RFC §4.3):
 *
 * ```
 * collie-pack-warrant-v1\n<packId>\n<generation>\n<leadMemberId>\n<deputyMemberId>\n<deputyFingerprint>\n<issuedAt>\n<refreshedAt>
 * ```
 *
 * Eight LF-separated fields. `deputyMemberId` and `deputyFingerprint` are the literal `-` in a
 * revocation warrant — an **empty** field there would make two different objects share a string.
 * `refreshedAt` is inside the signature because a refresh is a new signature over a new claim about
 * time, not the old signature re-stamped: that is what stops a captured warrant being walked forward.
 */
export function canonicalWarrant(w: Warrant): string {
  return [
    WARRANT_DOMAIN,
    w.packId,
    String(w.generation),
    w.leadMemberId,
    w.deputyMemberId ?? NONE,
    w.deputyFingerprint ?? NONE,
    String(w.issuedAt),
    String(w.refreshedAt),
  ].join("\n");
}

/** Did the member whose certificate this is sign this warrant? The whole of the crypto question. */
export function verifyWarrantSignature(w: Warrant, leadCertPem: string): boolean {
  return verifyCanonical(leadCertPem, w.signature, canonicalWarrant(w));
}

/** Epoch ms at which this warrant is dead on every clock that reads it (RFC §4.5). */
export function warrantExpiresAt(w: Warrant): number {
  return w.refreshedAt + WARRANT_TTL_MS;
}

/**
 * Is this warrant past its life?
 *
 * Evaluated on **each verifier's own clock**, and §8.6 already establishes that another member's
 * clock is never trusted for freshness. A machine whose clock is a month fast disarms its own door
 * early — the fail-closed direction, and accepted.
 */
export function warrantExpired(w: Warrant, now: number): boolean {
  return now >= warrantExpiresAt(w);
}

/**
 * Does `incoming` replace `stored`? RFC §4.4's rule, monotone on **both** axes.
 *
 * A lower generation is discarded silently; so is the same generation with a `refreshedAt` no newer
 * than the one already held. That is the replay defence (RFC §12, F8) and it is what makes a refresh
 * unable to walk a warrant backwards. `stored === null` accepts anything that got this far.
 */
export function warrantSupersedes(stored: Warrant | null | undefined, incoming: Warrant): boolean {
  if (stored === null || stored === undefined) return true;
  if (incoming.generation !== stored.generation) return incoming.generation > stored.generation;
  return incoming.refreshedAt > stored.refreshedAt;
}

/** The warrant this collie currently holds, or `null`. Absent and `null` are the same answer here. */
export function currentWarrant(data: TrustStoreData | null): StoredWarrant | null {
  return data?.warrant ?? null;
}

/**
 * The generation a fresh mint takes. **Never resets** (RFC §4.4) — it survives revocation, restart
 * and promotion, because a counter that resets would make an old warrant verify again.
 */
export function nextWarrantGeneration(data: TrustStoreData): number {
  return (currentWarrant(data)?.warrant.generation ?? 0) + 1;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/** The record inside a parsed JSON body, or null when the value isn't one. */
function asRecord(value: JsonValue | undefined): JsonObject | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

/**
 * A warrant off the wire, or `null`.
 *
 * The two deputy fields are read as a **pair** — both named or both null — so a half-named deputy is
 * refused here rather than reasoned about downstream. Nothing here checks the signature: that needs a
 * certificate the parser does not have.
 */
export function parseWarrant(value: JsonValue | undefined): Warrant | null {
  const w = asRecord(value);
  if (w === null) return null;
  if (typeof w.packId !== "string" || w.packId === "") return null;
  if (typeof w.generation !== "number" || !Number.isSafeInteger(w.generation) || w.generation < 1) return null;
  if (!isMemberId(w.leadMemberId)) return null;
  if (typeof w.issuedAt !== "number" || typeof w.refreshedAt !== "number") return null;
  if (typeof w.signature !== "string" || w.signature === "") return null;

  let deputyMemberId: string | null = null;
  let deputyFingerprint: string | null = null;
  if (w.deputyMemberId !== null || w.deputyFingerprint !== null) {
    const fingerprint = typeof w.deputyFingerprint === "string" ? normalizeFingerprint(w.deputyFingerprint) : null;
    if (!isMemberId(w.deputyMemberId) || fingerprint === null) return null;
    deputyMemberId = w.deputyMemberId;
    deputyFingerprint = fingerprint;
  }
  return {
    packId: w.packId,
    generation: w.generation,
    deputyMemberId,
    deputyFingerprint,
    leadMemberId: w.leadMemberId,
    issuedAt: w.issuedAt,
    refreshedAt: w.refreshedAt,
    signature: w.signature,
  };
}

// ── The lead's half ──────────────────────────────────────────────────────────

/**
 * `collie pack deputy <member>` — mint generation N+1 naming `deputyMemberId`, or naming **nobody**
 * when it is `null` (RFC §4.4's revocation).
 *
 * Refuses (`null`) unless this collie leads a pack and the named member is an **enrolled** peer of
 * its own roster holding the current secret generation — the same validation `pack approve-promote`
 * performs, and for the same reason: naming a member the lead does not pin is a typo, not a consent.
 * A lead cannot name itself, because a member id it does not pin is not in `peers`.
 *
 * **At most one standing warrant exists at any time.** Naming a second deputy does not add one; it
 * supersedes the first everywhere the new generation lands (RFC §3). A revocation with nothing to
 * revoke writes nothing.
 */
export function mintWarrant(
  data: TrustStoreData,
  deputyMemberId: string | null,
  now: number,
): PackChange<Warrant> | null {
  const pack = data.pack;
  if (pack === null || data.lead !== null || data.peers.length === 0) return null;

  let deputy: { memberId: string; fingerprint: string } | null = null;
  if (deputyMemberId !== null) {
    const member = data.peers.find((p) => p.memberId === deputyMemberId && p.status === "enrolled");
    if (member === undefined || member.secretGeneration !== pack.secretGeneration) return null;
    deputy = { memberId: member.memberId, fingerprint: member.fingerprint };
  } else if (currentWarrant(data) === null) {
    // Revoking nothing. An absence cannot be distinguished from a lost message, so there is no
    // warrant to mint here — the pack already names nobody (RFC §4.4).
    return null;
  }

  const warrant = sign(data, {
    packId: pack.packId,
    generation: nextWarrantGeneration(data),
    deputyMemberId: deputy?.memberId ?? null,
    deputyFingerprint: deputy?.fingerprint ?? null,
    leadMemberId: data.self.memberId,
    issuedAt: now,
    refreshedAt: now,
  });
  return {
    // The designation and the signed artefact are written in ONE step, so they can never disagree
    // about who the deputy is. The lead keeps no copy of the deputy's certificate: it pins the
    // deputy in its own roster, and a second copy would be a second thing to keep in step.
    // `deputySpentAt` is cleared here, and only here: it answers "why does this lead name nobody?",
    // and the operator has just answered it by naming somebody. Leaving it would make a freshly
    // designated pack still explain itself with a takeover that is now history.
    next: {
      ...data,
      deputy: warrant.deputyMemberId,
      deputySpentAt: null,
      warrant: { warrant, deputyCertPem: null },
    },
    result: warrant,
    audit: {
      action: warrant.deputyMemberId === null ? "pack.deputy.revoke" : "pack.deputy.name",
      detail: { member: warrant.deputyMemberId, generation: warrant.generation },
    },
  };
}

/**
 * Re-sign the CURRENT generation with a new `refreshedAt` (RFC §4.5) — same generation, same deputy,
 * same fingerprint, new signature.
 *
 * `null` — nothing to write — when there is no warrant, when this collie does not lead one it issued
 * itself, or when the last refresh is younger than {@link WARRANT_REFRESH_INTERVAL_MS}. That last
 * clause is the wire budget: the refresh is what a peer is re-pushed for, so refreshing on every
 * sweep would push on every sweep.
 *
 * **An EXPIRED warrant is not refreshed.** It is dead on every clock that holds it (RFC §4.5), and
 * re-signing it here would silently re-arm a pack that has been dark for a month without the operator
 * doing anything. Re-running `pack deputy` is the way back, and it is one verb.
 */
export function refreshWarrant(data: TrustStoreData, now: number): PackChange<Warrant> | null {
  const stored = currentWarrant(data);
  if (stored === null || data.pack === null || data.lead !== null) return null;
  const held = stored.warrant;
  if (held.leadMemberId !== data.self.memberId || held.packId !== data.pack.packId) return null;
  if (warrantExpired(held, now)) return null;
  if (now - held.refreshedAt < WARRANT_REFRESH_INTERVAL_MS) return null;
  // A clock that jumped backwards must not walk the warrant backwards either: the refresh has to
  // supersede what is held, or it is not a refresh (RFC §4.4's monotonicity, applied at the source).
  if (now <= held.refreshedAt) return null;

  const warrant = sign(data, { ...held, refreshedAt: now });
  return {
    next: { ...data, warrant: { ...stored, warrant } },
    result: warrant,
    audit: {
      action: "pack.deputy.refresh",
      detail: { member: warrant.deputyMemberId, generation: warrant.generation },
    },
  };
}

/** Sign an unsigned warrant with this collie's own identity key. The only signing site here. */
function sign(data: TrustStoreData, unsigned: Omit<Warrant, "signature">): Warrant {
  const draft: Warrant = { ...unsigned, signature: "" };
  return { ...unsigned, signature: signCanonical(data.self.keyPem, canonicalWarrant(draft)) };
}

// ── What a member reports, and what the lead does with it ─────────────────────

/**
 * What a member says about the warrant it holds, on `hello` and `snapshot` (RFC §11.2).
 *
 * **Absent means "no warrant, or a build that does not know about warrants"** — never "up to date",
 * and a missing `warrantRefreshedAt` is never read as *recently refreshed*. Both readings push.
 */
export interface WarrantReport {
  readonly generation: number;
  readonly refreshedAt: number;
}

/** This collie's own report, for the two response bodies. `null` ⇒ the fields are simply omitted. */
export function warrantReportOf(data: TrustStoreData | null): WarrantReport | null {
  const stored = currentWarrant(data);
  if (stored === null) return null;
  return { generation: stored.warrant.generation, refreshedAt: stored.warrant.refreshedAt };
}

/**
 * Read a member's report off a `hello`/`snapshot` body. `null` for anything that is not a complete,
 * well-formed pair — a half-reported pair is exactly as unknown as an absent one, and unknown pushes.
 */
export function parseWarrantReport(value: JsonValue | undefined): WarrantReport | null {
  const body = asRecord(value);
  if (body === null) return null;
  const generation = body.warrantGeneration;
  const refreshedAt = body.warrantRefreshedAt;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation)) return null;
  if (typeof refreshedAt !== "number") return null;
  return { generation, refreshedAt };
}

/**
 * Read a member's ACTIVATION report off a `hello`/`snapshot` body — §18.17's `warrantActiveGeneration`.
 *
 * `null` for absent, for a value that is not a safe integer, and for a build that predates the
 * amendment. **Absent means "nothing active there, or a build that cannot say" — never "armed"**, and
 * that reading is what makes the lead fall back to the lower bound in its own `pack-ops.json` and
 * keep printing the remedy. Read on its own rather than as part of {@link parseWarrantReport}: what a
 * member STORES and what its listener ACTIVATED are two independent facts, and a build that reports
 * one and not the other must not lose both.
 */
export function parseWarrantActiveReport(value: JsonValue | undefined): number | null {
  const body = asRecord(value);
  if (body === null) return null;
  const active = body.warrantActiveGeneration;
  return typeof active === "number" && Number.isSafeInteger(active) ? active : null;
}

/**
 * Is this member behind the warrant the lead currently issues? (RFC §5's re-push rule.)
 *
 * A two-field comparison on an exchange that already happens, so it costs no dial to *decide* — only
 * the push itself costs one, and only when a member is genuinely behind. It carries three cases at
 * once: a peer that was offline when the deputy was named, a peer that has never heard of warrants,
 * and every peer once an hour when the signature is refreshed.
 */
export function warrantPushNeeded(current: Warrant | null, reported: WarrantReport | null): boolean {
  if (current === null) return false;
  if (reported === null) return true;
  if (reported.generation !== current.generation) return reported.generation < current.generation;
  return reported.refreshedAt < current.refreshedAt;
}

// ── The receiving half ───────────────────────────────────────────────────────

/** The body of `POST /pack/v1/warrant` (RFC §11.1). */
export interface WarrantPush {
  readonly warrant: Warrant;
  /**
   * The deputy's certificate, PEM — present exactly when the warrant names a deputy (RFC §5).
   *
   * It is inside the signature **by proxy, not by inclusion**: the warrant signs the *fingerprint*
   * and the certificate is checked against it on arrival, so signing a ~700-byte blob would buy no
   * additional guarantee.
   */
  readonly deputyCertPem?: string;
  /**
   * The lead's current roster — **on the push to the DEPUTY and to nobody else** (RFC §7.4).
   *
   * The signed warrant carries no roster and that stands; this rides beside it. The deputy cannot
   * lead a pack it cannot dial and holds exactly one roster entry of its own, so the alternative to
   * this field is a takeover into a pack the new lead cannot see. It is the identical payload
   * §14.3's successful demotion already returns, for the identical reason.
   *
   * **Not signed, and it does not need to be**: it arrives over a two-factor pack link from the
   * pinned lead, which is the trust basis every other lead→peer byte has. A recipient that is not the
   * named deputy discards it (`checkWarrantPush`), so an ordinary peer never stores one.
   */
  readonly roster?: readonly RosterRow[];
  /**
   * Where the SENDER should be dialled — present only on RFC §9's reconciliation push, where the
   * sender is a **new lead** telling a member that was down during the takeover.
   *
   * A hint and never an identity (§4): what the recipient pins is the certificate it already
   * anchored, and this only decides where it is dialled. An ordinary lead→peer push omits it, and a
   * recipient that is not being re-pinned never reads it.
   */
  readonly address?: string;
}

/** Why a pushed warrant was refused. Local vocabulary — the wire says far less than this does. */
export type WarrantRefusal =
  /** The body is not a warrant. */
  | "malformed"
  /** A warrant for another pack, or one this collie's own lead did not issue. */
  | "foreign"
  /** The signature does not verify against the pinned lead's certificate. */
  | "bad-signature"
  /** The certificate that rode along is not the one the warrant's fingerprint names. */
  | "certificate-mismatch"
  /** Past `refreshedAt + WARRANT_TTL_MS` on this collie's own clock. */
  | "expired";

/** The verdict on one pushed warrant. `stale` is not a failure — it is "already at least this new". */
export type WarrantVerdict =
  /**
   * `roster` is present exactly when this collie is the deputy the warrant names AND the push carried
   * one (RFC §7.4). `null` on every other member: a roster is the deputy's business, and an ordinary
   * peer that stored one would be holding pins for machines it must never dial (§4).
   */
  | { readonly kind: "accept"; readonly stored: StoredWarrant; readonly roster: readonly RosterRow[] | null }
  | { readonly kind: "stale"; readonly generation: number }
  | { readonly kind: "refuse"; readonly reason: WarrantRefusal };

/**
 * The whole receiving decision, as a pure function (RFC §5, phase 1).
 *
 * Order is the rule, and it runs outside-in: shape, then *whose* warrant this is, then the signature,
 * then the certificate that rode with it, then the clock, then supersession. A caller who cannot sign
 * therefore never learns which generation this collie holds.
 *
 * `from` is the member the transport already admitted. The role check is the caller's — this function
 * asks only whether the warrant claims to come from the lead this collie pins, which is a different
 * question and both must be answered.
 */
export function checkWarrantPush(
  data: TrustStoreData | null,
  body: JsonValue | undefined,
  now: number,
): WarrantVerdict {
  const record = asRecord(body);
  const warrant = parseWarrant(record?.warrant);
  if (warrant === null) return { kind: "refuse", reason: "malformed" };

  const lead = data?.lead ?? null;
  if (data === null || data.pack === null || lead === null || lead.status !== "enrolled") {
    return { kind: "refuse", reason: "foreign" };
  }
  if (warrant.packId !== data.pack.packId || warrant.leadMemberId !== lead.memberId) {
    return { kind: "refuse", reason: "foreign" };
  }
  if (!verifyWarrantSignature(warrant, lead.certPem)) return { kind: "refuse", reason: "bad-signature" };

  // The certificate travels with its fingerprint and is accepted only if it IS that fingerprint —
  // §8.2's enrollment rule, for §8.2's reason: BoringSSL anchors on certificates, so a hash alone
  // could never be enforced. A revocation names nobody and must therefore carry nothing.
  const offered = typeof record?.deputyCertPem === "string" ? record.deputyCertPem : null;
  let deputyCertPem: string | null = null;
  if (warrant.deputyMemberId !== null && isFingerprint(warrant.deputyFingerprint)) {
    if (offered === null || fingerprintOfCert(offered) !== warrant.deputyFingerprint) {
      return { kind: "refuse", reason: "certificate-mismatch" };
    }
    deputyCertPem = offered;
  } else if (offered !== null) {
    return { kind: "refuse", reason: "certificate-mismatch" };
  }

  if (warrantExpired(warrant, now)) return { kind: "refuse", reason: "expired" };

  const held = currentWarrant(data)?.warrant ?? null;
  // Reported back as what this member actually holds, which is what the lead's next comparison reads.
  // `warrantSupersedes(null, …)` is always true, so a `stale` verdict always has a `held` warrant.
  if (!warrantSupersedes(held, warrant)) {
    return { kind: "stale", generation: held?.generation ?? warrant.generation };
  }

  // The roster (RFC §7.4). Read ONLY when this collie is the member the warrant names, so a push that
  // carried one to the wrong recipient stores nothing — and a malformed roster is dropped rather than
  // failing the warrant, because the warrant is the security object and the roster is the addressing
  // hint that rides with it. `parseRoster` re-checks `fingerprint === sha256(certPem)` on every row,
  // so a row this collie keeps is one it could actually pin.
  const forSelf = warrant.deputyMemberId === data.self.memberId;
  const roster = forSelf ? parseRoster(record?.roster) : null;

  return { kind: "accept", stored: { warrant, deputyCertPem }, roster };
}

/**
 * Belt and braces for the field that took a real pack dark: **a warrant stamped with another pack's
 * id is not this collie's warrant, so it is discarded.**
 *
 * `leavePack` now clears these fields, so a machine that leaves cleanly never reaches this. What
 * reaches it is a store written by an older build, or a `join` that landed beside a warrant nobody
 * cleared. Either way the fields describe a pack this collie is not in, and the cost of keeping them
 * is that this machine reports a generation its own lead never minted — which is read as a takeover
 * on the far end.
 *
 * `null` — nothing to write — when there is no pack, no warrant, or the warrant is this pack's.
 * `standbyRoster` and `deputy` go with it: all three were written by the same push, from the same
 * lead, about the same pack.
 */
export function discardForeignWarrant(
  data: TrustStoreData,
): PackChange<{ packId: string; generation: number }> | null {
  const stored = currentWarrant(data);
  if (data.pack === null || stored === null) return null;
  if (stored.warrant.packId === data.pack.packId) return null;
  return {
    next: { ...data, warrant: null, standbyRoster: null, deputy: null },
    result: { packId: stored.warrant.packId, generation: stored.warrant.generation },
    audit: {
      action: "pack.warrant.foreign",
      detail: { pack: stored.warrant.packId, generation: stored.warrant.generation },
    },
  };
}

/**
 * Persist an accepted warrant. The store's `deputy` designation is NOT written here: that field is
 * the operator's designation **on the lead**, and a peer that copied it would be recording a decision
 * it did not make. Who the deputy is, on a peer, is inside the warrant.
 */
export function storeWarrant(
  data: TrustStoreData,
  stored: StoredWarrant,
  /**
   * The roster that rode along (RFC §7.4), when this collie is the deputy the warrant names. `null`
   * leaves whatever is already held rather than clearing it: a push whose roster failed to parse must
   * not disarm a deputy that already has a good one, and a lead that stopped sending one is a lead
   * running an older build — neither is evidence the pack shrank to nothing.
   */
  roster: readonly RosterRow[] | null = null,
): PackChange<Warrant> {
  return {
    next: roster === null ? { ...data, warrant: stored } : { ...data, warrant: stored, standbyRoster: roster },
    result: stored.warrant,
    audit: {
      action: "pack.warrant.stored",
      detail: { member: stored.warrant.deputyMemberId, generation: stored.warrant.generation },
    },
  };
}

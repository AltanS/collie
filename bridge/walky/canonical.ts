// The signed form of a walky talky message (M62 README, "The message"). One fixed domain tag, LF
// between fields, `-` for every null field: an empty field would let two messages share a string
// (CREW_PROTOCOL §8.6). `from.label` is display data and is not signed; `to` is signed, so a
// message cannot be re-aimed. The body enters as its SHA-256, so the string stays one line per field.
//
// The signature is the primitive the crew already has (bridge/crew/signing.ts). A solo install
// mints no key and signs nothing (CREW_PROTOCOL §11).

import { createHash } from "node:crypto";

import { signCanonical, verifyCanonical } from "../crew/signing.ts";
import type { WalkyMessage } from "./types.ts";

/** The domain tag of a message's canonical string. */
export const WALKY_DOMAIN = "collie-walky-v1";
/** The domain tag of the lead's attestation (spec 03 signs it on the lead-to-peer hop). */
export const WALKY_ATTEST_DOMAIN = "collie-walky-attest-v1";
/** The domain tag of the lead's voucher for a sender's certificate (CREW_PROTOCOL §21, added 2026-10-18). */
export const WALKY_VOUCHER_DOMAIN = "collie-walky-voucher-v1";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function field(value: string | null): string {
  return value === null ? "-" : value;
}

/** The fields a signature covers. */
export type SignedFields = Pick<WalkyMessage, "id" | "kind" | "from" | "to" | "replyTo" | "at" | "body">;

/** The canonical string of a message. */
export function canonicalMessage(message: SignedFields): string {
  return [
    WALKY_DOMAIN,
    message.id,
    message.kind,
    field(message.from.memberId),
    field(message.from.address),
    field(message.from.harness),
    message.to,
    field(message.replyTo),
    String(message.at),
    sha256Hex(message.body),
  ].join("\n");
}

/** The message, signed by `signer` with the PKCS#8 key behind its pinned certificate. */
export function signMessage(message: WalkyMessage, keyPem: string, signer: string): WalkyMessage {
  return { ...message, signer, signature: signCanonical(keyPem, canonicalMessage(message)) };
}

/** Did the holder of `certPem` sign this message as it stands? An unsigned message never verifies. */
export function verifyMessage(message: WalkyMessage, certPem: string): boolean {
  if (message.signature === null || message.signer === null) return false;
  return verifyCanonical(certPem, message.signature, canonicalMessage(message));
}

/**
 * The string the lead signs beside a message it routes to a member: the message id, the crew, the
 * receiving member and the hash of the message's canonical string. It binds the crew id and the
 * receiver, so an attested message cannot be replayed into another crew or at another member (§16).
 */
export function attestationString(message: SignedFields, crewId: string, receiver: string): string {
  return [WALKY_ATTEST_DOMAIN, message.id, crewId, receiver, sha256Hex(canonicalMessage(message))].join("\n");
}

/**
 * The string the lead signs beside a message from another member of its roster: the crew, the
 * sending member and the SHA-256 fingerprint of the certificate the lead pinned for it (lowercase
 * hex over the DER, `fingerprintOfCert` in bridge/crew/identity.ts). With it, a member that pins only
 * its lead can check the sender's own signature: the lead vouches that this certificate is that
 * member's. It binds the crew, so a voucher is not good in another crew.
 */
export function voucherString(crewId: string, memberId: string, fingerprint: string): string {
  return [WALKY_VOUCHER_DOMAIN, crewId, memberId, fingerprint].join("\n");
}

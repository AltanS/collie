import { X509Certificate } from "node:crypto";

import type { PackMode } from "../types.ts";
import { fingerprintOfCert } from "./identity.ts";
import type { TrustedMember, TrustStoreData } from "./trust-store.ts";
import { verifyWarrantSignature, warrantExpired } from "./warrant.ts";

// The TLS layer of §8.1's first factor: where the pinned certificate is actually ENFORCED.
//
// ── THE ONE FACT THAT SHAPES THIS WHOLE FILE ─────────────────────────────────
// `Bun.serve` can *enforce* a client certificate (BoringSSL verifies the presented chain against a
// pinned `ca`, and an unpinned or absent certificate never completes the handshake) but exposes **no
// accessor for the certificate a caller presented** — not on `Server`, not on `Request`, and not via
// `node:https`, whose socket is a shim with no `getPeerCertificate`. Measured on Bun 1.3.14; the
// investigation is recorded in `.tracker/M4-pack-federation-engine/08-*.md`.
//
// So identity is not *read* per request. It is decided at bind time and attested to the admission
// gate as a boolean: the listener was constructed pin-enforcing, or it was not
// (`PackRequestFacts.transportPinned`, bridge/pack/admission.ts). Everything else follows:
//
//   • A PEER's `ca` list holds its lead's certificate — because a peer's roster holds exactly one
//     member (§8.2 step 4) — and, since §18.5, **at most one more**: the deputy named by a warrant
//     this peer has verified against that same lead's key. Never more than two, and never fewer than
//     today: a missing, malformed, foreign, unsigned or expired warrant leaves the list at exactly
//     the one anchor it has always held.
//
//     ** AND THE HONEST CONSEQUENCE OF THE SECOND ANCHOR, STATED WHERE THE CODE IS.** With one
//     anchor, "the handshake was pin-enforcing" named a unique member and the boolean was sufficient
//     rather than lossy. With two it names *one of two*, and Bun still exposes no accessor for the
//     certificate a caller presented — so a two-anchored peer attributes an UNSIGNED admitted request
//     to its lead, and a deputy that dialled it unsigned would be read as the lead. That is not a
//     hole this file can close (`server.reload` cannot re-pin, and refusing unsigned requests would
//     refuse the lead's own poll); it is the reach the operator granted when they named the deputy,
//     and RFC §12's F7 mitigation is the one that applies — **make the deputy the second machine you
//     most trust.** A pack that names none is unaffected, byte for byte.
//   • A LEAD does not pin its listener at all. Its pack surface rides the front door, and
//     `tailscale serve` (or any conforming proxy, DEPLOYMENT.md Variant C) terminates TLS before
//     the process sees the connection — no client certificate can survive to it under ANY
//     design. Peer→lead requests re-establish the second factor at the application layer instead (§8.6,
//     bridge/pack/signing.ts).
//   • There is **no live re-pin**. `server.reload({ tls })` does NOT swap the `ca` list — verified:
//     a member added after bind is still refused. Membership changes therefore take effect through
//     the restart every membership verb already performs (`applyLocally` in cli/pack.ts), which is
//     also why they perform it.

/** TLS options for a listener or a dial. Structural on purpose — Bun's and Node's shapes both fit. */
export interface PackTlsOptions {
  readonly cert: string;
  readonly key: string;
  readonly ca: readonly string[];
  readonly requestCert?: boolean;
  readonly rejectUnauthorized?: boolean;
  readonly checkServerIdentity?: () => undefined;
  readonly serverName?: string;
}

/** A `fetch` init that may carry TLS material. Bun honours `tls`; the type just says so out loud. */
export type PackRequestInit = RequestInit & { tls?: PackTlsOptions };

/**
 * The peer listener's TLS configuration, or `null` when this collie must not pin one.
 *
 * `null` for a lead, for a solo instance, and for a peer whose store cannot produce an anchor. That
 * last case is a **mis-wiring**, and it is deliberately not repaired here: the caller passes
 * `transportPinned: false` to the router, admission then refuses every request, and the pack is down
 * rather than single-factor. Fail-closed is the only safe reading of "the pin could not be built".
 */
export function peerListenerTls(
  mode: PackMode,
  data: TrustStoreData | null,
  /** This collie's own clock, for the warrant's validity. Supplied so the anchor matrix is testable. */
  now: number = Date.now(),
): PackTlsOptions | null {
  if (mode !== "peer" || data === null) return null;
  const lead = data.lead;
  if (lead === null || lead.status !== "enrolled" || lead.certPem === "") return null;
  const deputy = deputyAnchor(data, lead, now);
  return {
    cert: data.self.certPem,
    key: data.self.keyPem,
    // This peer's lead, and at most the one deputy a verified warrant names. Not "every member" — a
    // peer has no peers (§4) — and not a system trust store, which would make any publicly-issued
    // certificate a member.
    ca: deputy === null ? [lead.certPem] : [lead.certPem, deputy],
    requestCert: true,
    rejectUnauthorized: true,
  };
}

/**
 * The second anchor, or `null` — RFC §5's phase 2, "anchored".
 *
 * **It exists iff the stored warrant verifies against the certificate this peer already pinned as
 * its lead's.** That is the whole trust question, and every other clause below is a way of making
 * sure it is the one being asked:
 *
 *   • the warrant must be for THIS pack and issued by THIS peer's lead — a warrant from anywhere else
 *     is not this lead's consent, however well it is signed;
 *   • it must name a deputy — a revocation names nobody and therefore anchors nobody (§18.3);
 *   • the certificate that rode with it must BE the fingerprint the warrant names. §8.2's enrollment
 *     rule, for §8.2's reason: BoringSSL anchors on certificates, so a hash alone could never be
 *     enforced, and a certificate accepted without that check would be an anchor nobody signed;
 *   • it must not be past its 30 days on THIS machine's clock (§18.4). A dark pack disarms itself,
 *     and it disarms here — at the transport — as well as at the door;
 *   • and it must not name a machine that is already in the list. Anchoring this collie's own
 *     certificate, or its lead's a second time, would add a member that is not there.
 *
 * A refusal at any clause is silent and total: the listener is built with exactly today's single
 * anchor, which is the pre-amendment behaviour and the fail-closed reading of "the warrant could not
 * be believed". **Never fewer anchors than today** — the lead's own certificate is not in question
 * here and is never dropped, so an existing lead's handshake is unaffected by any of this.
 *
 * Exported as {@link deputyAnchorOf} because the admission gate needs the SAME answer this listener
 * was built from: a two-anchored peer must resolve its caller by signature rather than by the
 * transport boolean (§8.1's amendment), and the certificate to check a deputy's signature against is
 * this one. Both callers read it once, off one clock, so the listener and the gate cannot disagree.
 */
export function deputyAnchorOf(mode: PackMode, data: TrustStoreData | null, now: number = Date.now()): string | null {
  if (mode !== "peer" || data === null) return null;
  const lead = data.lead;
  if (lead === null || lead.status !== "enrolled" || lead.certPem === "") return null;
  return deputyAnchor(data, lead, now);
}

function deputyAnchor(data: TrustStoreData, lead: TrustedMember, now: number): string | null {
  const stored = data.warrant ?? null;
  if (stored === null || data.pack === null) return null;
  const w = stored.warrant;
  if (w.packId !== data.pack.packId || w.leadMemberId !== lead.memberId) return null;
  if (w.deputyMemberId === null || w.deputyFingerprint === null) return null;
  if (w.deputyMemberId === data.self.memberId || w.deputyMemberId === lead.memberId) return null;
  if (stored.deputyCertPem === null || stored.deputyCertPem === "") return null;
  if (fingerprintOfCert(stored.deputyCertPem) !== w.deputyFingerprint) return null;
  if (warrantExpired(w, now)) return null;
  if (!verifyWarrantSignature(w, lead.certPem)) return null;
  return stored.deputyCertPem;
}

/**
 * The TLS material for dialling one pinned member — the lead→peer direction (§5, §9.1).
 *
 * Two halves, both required:
 *   • **`ca: [member.certPem]`** pins the server. A peer that answers with a different certificate is
 *     refused at the handshake, so `DEPTH_ZERO_SELF_SIGNED_CERT` is what a swapped machine looks like.
 *   • **`serverName` taken from the PINNED certificate's own first DNS SAN** neutralises the *name*
 *     check by making it tautological — SNI is a name that certificate already carries, so it can only
 *     ever match. This is still the Syncthing model §8.1 asks for and §4's addressing rule made
 *     mandatory: the name never comes from the dial ADDRESS, so a member the operator re-points
 *     (`collie reconnect`) cannot become untrusted because its SAN no longer covers where it is
 *     dialled at. Identity is still the certificate; the trust model is unchanged.
 *
 * The name check used to be switched OFF with `checkServerIdentity: () => undefined`, and that is now a
 * fallback only. Bun ≥1.4 refuses to POOL a `fetch` whose `tls` options carry a `checkServerIdentity`
 * callback, and pooling is exactly what §10.4 of PACK_PROTOCOL.md rides: without it every strict-budget
 * dial handshakes cold and a DERP-relayed peer never bootstraps. A certificate that names nothing keeps
 * the callback and simply does not pool — correct, just slower. The SNI itself is a tailnet name and it
 * travels inside the tailnet's own encryption, so naming it on the wire is no public-wire disclosure.
 *
 * `cert`/`key` are this collie's own, so the peer's listener can pin us back — the pair is symmetric.
 * Returns `null` when the member carries no certificate, which the caller must treat as unreachable
 * rather than dial unpinned.
 */
export function dialTls(data: TrustStoreData | null, member: Pick<TrustedMember, "certPem">): PackTlsOptions | null {
  if (data === null || member.certPem === "") return null;
  const base = {
    cert: data.self.certPem,
    key: data.self.keyPem,
    ca: [member.certPem],
    rejectUnauthorized: true,
  } as const;
  const sni = pinnedServerName(member.certPem);
  if (sni === null) return { ...base, checkServerIdentity: () => undefined };
  return { ...base, serverName: sni };
}

const pinnedNames = new Map<string, string | null>();

/**
 * A name the PINNED certificate already carries, for use as SNI — the name check made tautological
 * instead of switched off (see {@link dialTls}). `null` when the certificate names nothing, which
 * sends the caller back to the `checkServerIdentity` override.
 */
function pinnedServerName(certPem: string): string | null {
  const cached = pinnedNames.get(certPem);
  if (cached !== undefined) return cached;
  const found = firstDnsName(certPem);
  pinnedNames.set(certPem, found);
  return found;
}

function firstDnsName(certPem: string): string | null {
  let san = "";
  try {
    san = new X509Certificate(certPem).subjectAltName ?? "";
  } catch {
    return null;
  }
  for (const entry of san.split(", ")) {
    if (!entry.startsWith("DNS:")) continue;
    const value = entry.slice(4).replace(/^"|"$/g, "");
    if (value !== "") return value;
  }
  return null;
}

import type { PackMode } from "../types.ts";
import type { TrustedMember, TrustStoreData } from "./trust-store.ts";

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
//   • A PEER's `ca` list holds exactly one certificate — its lead's — because a peer's roster holds
//     exactly one member (§8.2 step 4). An admitted connection therefore *cannot* be anyone else,
//     which is what makes a boolean sufficient rather than lossy.
//   • A LEAD does not pin its listener at all. Its pack surface rides the front door, and
//     `tailscale serve` (or any conforming proxy, README Variant C) terminates TLS before the process
//     sees the connection — no client certificate can survive to it under ANY design. Peer→lead
//     requests re-establish the second factor at the application layer instead (§8.6,
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
export function peerListenerTls(mode: PackMode, data: TrustStoreData | null): PackTlsOptions | null {
  if (mode !== "peer" || data === null) return null;
  const lead = data.lead;
  if (lead === null || lead.status !== "enrolled" || lead.certPem === "") return null;
  return {
    cert: data.self.certPem,
    key: data.self.keyPem,
    // Exactly one anchor: this peer's lead. Not "every member" — a peer has no peers (§4) — and not
    // a system trust store, which would make any publicly-issued certificate a member.
    ca: [lead.certPem],
    requestCert: true,
    rejectUnauthorized: true,
  };
}

/**
 * The TLS material for dialling one pinned member — the lead→peer direction (§5, §9.1).
 *
 * Two halves, both required:
 *   • **`ca: [member.certPem]`** pins the server. A peer that answers with a different certificate is
 *     refused at the handshake, so `DEPTH_ZERO_SELF_SIGNED_CERT` is what a swapped machine looks like.
 *   • **`checkServerIdentity: () => undefined`** removes the *name* check. This is the Syncthing model
 *     §8.1 asks for and §4's addressing rule made mandatory: an address is a hint the operator may
 *     re-point (`collie reconnect`), so a member that roams must not become untrusted because its SAN
 *     no longer covers the address it is dialled at. Identity is the certificate; the name is noise.
 *
 * `cert`/`key` are this collie's own, so the peer's listener can pin us back — the pair is symmetric.
 * Returns `null` when the member carries no certificate, which the caller must treat as unreachable
 * rather than dial unpinned.
 */
export function dialTls(data: TrustStoreData | null, member: Pick<TrustedMember, "certPem">): PackTlsOptions | null {
  if (data === null || member.certPem === "") return null;
  return {
    cert: data.self.certPem,
    key: data.self.keyPem,
    ca: [member.certPem],
    rejectUnauthorized: true,
    checkServerIdentity: () => undefined,
  };
}

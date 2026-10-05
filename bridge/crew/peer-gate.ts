// The PEER's own authorisation for a request that arrived over a crew link (CREW_PROTOCOL.md §12).
//
// ── THE RULE THIS FILE EXISTS FOR ────────────────────────────────────────────
// "A peer is never asked to trust the lead's authorisation decision in place of its own. The peer
// applies its own write-level checks to a crew request; the lead's gate does not stand in for them."
//
// So: the lead having decided the operator may write is NOT an input here. Nothing in this module
// reads a verdict from the wire. What it reads is the peer's OWN config — the same `deviceHeader` +
// `deviceAllowlist` its own operator set — applied to the device identity the link carried.
//
// ── WHY NOT JUST CALL guard() ────────────────────────────────────────────────
// `guard()`/`checkAccess()` are a BROWSER gate: an `Origin` compared against a `Host`, a host
// allowlist against DNS rebinding, an `Origin`-required-for-writes rule against CSRF. A crew request
// satisfies none of those preconditions by construction — it is not a browser, has no origin, and is
// not subject to CSRF because no browser can be made to emit it. Running it through `checkAccess`
// would refuse every forwarded write on a rule about a threat that is not present.
//
// What that rule was BUYING — proof the request came from someone entitled to drive this terminal —
// is bought here by the crew link's two independent factors (pinned certificate + crew secret, §8.1,
// ADR 0013), which are strictly stronger than same-origin. The device layer is what remains, and it
// is what this function applies, unchanged and locally owned.

import { decodeDeviceHeader, DEVICE_HEADER } from "./admission.ts";

/** The slice of `Config` this gate reads. Narrowed so a test needs no `loadConfig`. */
export interface PeerGateConfig {
  /** `COLLIE_DEVICE_HEADER` — empty ⇒ the device feature is off on THIS machine. */
  readonly deviceHeader: string;
  readonly deviceAllowlist: readonly string[];
}

export type PeerGateVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * The level a session-scoped route asks its caller's gate at, on both callers (the browser's
 * `guard()` and this file's {@link crewGate}).
 *
 * - `read`: looking. Allowed to any caller the front door (or the crew link) admitted.
 * - `device-read`: looking at something only an authorised device may see, the Files view
 *   (ADR 0083). It changes nothing, so it is still a READ for forwarding, audit and the `Origin`
 *   rule; what it borrows from `write` is the device decision, on each machine by its own policy.
 * - `write`: typing into or restructuring a terminal.
 */
export type GateLevel = "read" | "device-read" | "write";

/**
 * May this crew-originated request run, at `level`, on this peer?
 *
 * Reads exactly like {@link deviceAuth}'s matrix, because it IS that matrix — the peer's own policy,
 * evaluated against the device the lead forwarded as `X-Crew-Device`:
 *
 *   - device feature off on this peer  → authorised (today's behaviour for its own operator, and it
 *     would be strange for enrolling in a crew to silently turn on a gate nobody configured);
 *   - device absent                    → read-only. The lead omits the header when ITS gate is off,
 *     and a peer that turned the gate on asked for every write to name a device;
 *   - device present and allowlisted   → authorised, and the peer's audit line names it;
 *   - device present, not on THIS      → read-only. This is the case the whole file is about: the
 *     peer's allowlist, not the lead's, decides. A device the lead trusts and the peer does not
 *     cannot write on the peer.
 *
 * Reads are always allowed: the link's two factors already admitted the caller, and mirroring a pane
 * is exactly what a crew is for. That is the same asymmetry `guard()` has locally.
 *
 * A `device-read` (the Files view, ADR 0083) takes the write branch below: the member's OWN device
 * policy decides whether that device may browse this member's files, exactly as it decides whether it
 * may type here. The lead's pairing check ran before the forward; pairing is lead-local and never
 * crosses the link, the same as for a write.
 */
export function crewGate(level: GateLevel, cfg: PeerGateConfig, device: string | null): PeerGateVerdict {
  if (level === "read") return { ok: true };
  if (cfg.deviceHeader === "") return { ok: true };
  if (device === null || device === "") {
    return { ok: false, reason: "device not authorised: the crew request named no device" };
  }
  if (device === "unknown" || !cfg.deviceAllowlist.includes(device)) {
    return { ok: false, reason: "device not authorised on this host" };
  }
  return { ok: true };
}

/**
 * Read the forwarded device identity off a crew request (§6). Blank and absent are the same thing.
 *
 * Always `X-Crew-Device`, never the peer's own `COLLIE_DEVICE_HEADER`: the crew link is the trust
 * basis for this value (§12), and a peer whose device feature is OFF still wants the identity in its
 * audit line. Attribution and authorisation are different questions — this answers the first, and
 * {@link crewGate} answers the second.
 */
export function crewDeviceOf(req: Request): string | null {
  const raw = req.headers.get(DEVICE_HEADER)?.trim();
  if (!raw) return null;
  const device = decodeDeviceHeader(raw).trim();
  return device === "" ? null : device;
}

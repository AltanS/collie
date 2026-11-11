import type { AuditEntry } from "./audit.ts";
import type { MintedIn } from "./pairing.ts";

// The audit line of one pairing (2026-11-11): where the claim came from, and which pane made the code.
//
// ── NO ADDRESS, ONLY ITS CLASS ───────────────────────────────────────────────
// The trail answers "did this pairing come from this machine, the tailnet, a LAN or the internet", and
// never keeps the address itself: no other line of the trail keeps a phone's address, and a class is
// enough to see a pairing that should not have happened. `route` is the class of the TCP peer, which the
// kernel gives and nobody can forge. `forwardedFrom` is the class of the rightmost `X-Forwarded-For` entry,
// read only when the peer is loopback (a front door on this machine, `tailscale serve` or a proxy), the
// same entry the pair limit counts (`pairSourceKey`). A local process can write that header itself, so
// `forwardedFrom` is the front door's word, or the caller's: `route: "loopback"` is the fact.
//
// ── NEVER THE CODE OR THE TOKEN ──────────────────────────────────────────────
// The line is built from the label, the two classes and the pane the pending file named. Neither the
// code the device typed nor the token the claim minted is a parameter of {@link pairAuditEntry}, so no
// change inside it can put one on the line (pair-audit.test.ts pins that the line holds neither).

/** Where an address sits, as far as the trail needs to know. */
export type AddressClass = "loopback" | "tailnet" | "lan" | "internet" | "unknown";

/** An IPv4 address as four numbers, or null when it is not one. */
function ipv4(text: string): [number, number, number, number] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  if (nums.some((n) => !Number.isInteger(n) || n > 255)) return null;
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

function ipv4Class([a, b]: [number, number, number, number]): AddressClass {
  if (a === 127) return "loopback";
  // 100.64.0.0/10: the shared address space Tailscale and Headscale hand out.
  if (a === 100 && b >= 64 && b <= 127) return "tailnet";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return "lan";
  return "internet";
}

/**
 * The class of one address as the socket or a proxy wrote it: IPv4, IPv6, a v4-mapped IPv6, or the
 * bracketed form with a port a proxy can write. Anything that does not read as an address is `unknown`.
 */
export function addressClass(address: string | null | undefined): AddressClass {
  if (address === null || address === undefined) return "unknown";
  let a = address.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(a);
  if (bracketed) a = bracketed[1]!;
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(a)) a = a.replace(/:\d+$/, "");
  if (a.startsWith("::ffff:")) a = a.slice(7);
  const v4 = ipv4(a);
  if (v4 !== null) return ipv4Class(v4);
  if (!a.includes(":") || !/^[0-9a-f:]+$/.test(a)) return "unknown";
  if (a === "::1" || a === "0:0:0:0:0:0:0:1") return "loopback";
  // fd7a:115c:a1e0::/48: Tailscale's IPv6 range.
  if (a.startsWith("fd7a:115c:a1e0:")) return "tailnet";
  // fc00::/7 (unique local) and fe80::/10 (link local).
  if (/^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a)) return "lan";
  return "internet";
}

/** Where a claim came from: the peer's class, and the forwarded class when a front door on this machine passed it on. */
export interface PairRoute {
  readonly route: AddressClass;
  readonly forwarded?: AddressClass;
}

/**
 * The route of one `POST /api/pair`. `peerIsLoopback` is `isLoopbackPeer(peer)` (bridge/server.ts),
 * which reads an absent peer as loopback, so `route` follows it rather than calling an absent peer
 * `unknown`. The forwarded header counts only behind a loopback peer, and only its rightmost non-empty
 * entry, exactly as `pairSourceKey` reads it.
 */
export function pairRoute(peer: string | null | undefined, peerIsLoopback: boolean, forwardedFor: string | null): PairRoute {
  if (!peerIsLoopback) return { route: addressClass(peer) };
  const entries = (forwardedFor ?? "").split(",").map((e) => e.trim()).filter((e) => e !== "");
  const last = entries.at(-1);
  return last === undefined ? { route: "loopback" } : { route: "loopback", forwarded: addressClass(last) };
}

/** The words for a code whose pane nobody placed: run outside a pane, or with no bridge that knew it. */
export const NOT_PLACED = "not placed";

/**
 * The audit entry of one successful pairing. `action: "pair"`, the device's label in `device` and in
 * `detail.label` (as the line always had), plus `route`, `forwardedFrom` when there was one, and `mintPane`
 * and `mintSession` (the pane `collie pair` ran in, or {@link NOT_PLACED}). The label is the device's
 * only id: it is the handle `collie devices revoke` takes, and no other id exists.
 */
export function pairAuditEntry(label: string, where: PairRoute, mintedIn: MintedIn | null): AuditEntry {
  return {
    action: "pair",
    device: label,
    detail: {
      label,
      route: where.route,
      forwardedFrom: where.forwarded,
      mintSession: mintedIn?.session ?? NOT_PLACED,
      mintPane: mintedIn?.paneId ?? NOT_PLACED,
    },
  };
}

// ── Pairing by a request a paired phone approves (bridge/pair-request.ts, ADR 0139) ────────────
// Three lines, built here so the same rule holds: the parameters are classes, labels and a reason,
// never the code on the screen, the request's ids, the poll secret or the token.

/** One `POST /api/pair/request`: a browser asked to be paired, from this route. */
export function pairRequestAuditEntry(where: PairRoute): AuditEntry {
  return { action: "pair-request", detail: { route: where.route, forwardedFrom: where.forwarded } };
}

/**
 * One approved request: the paired device that tapped the right code (`device` and `detail.approver`),
 * the label the new device got, and both routes, the asker's from its request and the approver's from
 * its tap.
 */
export function pairApproveAuditEntry(args: {
  readonly approver: string;
  readonly label: string;
  readonly asker: PairRoute;
  readonly approverRoute: PairRoute;
}): AuditEntry {
  return {
    action: "pair-approve",
    device: args.approver,
    detail: {
      approver: args.approver,
      label: args.label,
      route: args.asker.route,
      forwardedFrom: args.asker.forwarded,
      approverRoute: args.approverRoute.route,
      approverForwardedFrom: args.approverRoute.forwarded,
    },
  };
}

/** Why a request ended without a device, or was never made. */
export type PairRequestRefusal = "wrong-code" | "refused" | "expired" | "rate" | "cancelled" | "replaced";

/**
 * One request that ended without a device (`wrong-code`, `refused`, `expired`; `cancelled` by its own
 * browser; `replaced` by a newer request from the same source), or was refused at the door (`rate`).
 */
export function pairRequestRefusedAuditEntry(reason: PairRequestRefusal, approver?: string): AuditEntry {
  const entry: AuditEntry = { action: "pair-request-refused", detail: { reason } };
  if (approver !== undefined) entry.device = approver;
  return entry;
}

import type { ServeMode } from "./context.ts";
import type { Exec } from "./sys.ts";

// `tailscale status --json` → this host's name. The shell piped that JSON through an inline
// interpreter one-liner (the pre-shim collie-ctl.sh) — exactly the runtime interpreter
// dependency the compiled binary exists to remove — so the parse moves in-process.

/** `Self.DNSName` with its trailing dot stripped, or null when the JSON says nothing useful. */
export function selfDnsName(statusJson: string): string | null {
  try {
    const data = JSON.parse(statusJson) as { Self?: { DNSName?: unknown } };
    const name = data.Self?.DNSName;
    if (typeof name !== "string") return null;
    const trimmed = name.replace(/\.$/, "").trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * The URL to open. `https://<name>` in https mode (tailscale terminates TLS on 443),
 * `http://<name>:<port>` in http mode, and a loopback URL that SAYS why when the tailnet name is
 * unavailable — an operator on Headscale reads that line to find out their setup isn't published.
 */
export function bridgeUrlFrom(name: string | null, mode: ServeMode, port: number): string {
  if (name === null) return `http://127.0.0.1:${port} (Tailscale name unavailable)`;
  return mode === "http" ? `http://${name}:${port}` : `https://${name}`;
}

/** {@link selfDnsName} over a live `tailscale status --json`. A missing CLI reads as no name. */
export function tailnetName(exec: Exec): string | null {
  const r = exec.capture("tailscale", ["status", "--json"]);
  if (!r.found || r.code !== 0) return null;
  return selfDnsName(r.stdout);
}

export function bridgeUrl(exec: Exec, mode: ServeMode, port: number): string {
  return bridgeUrlFrom(tailnetName(exec), mode, port);
}

// ── Is anyone allowed in? ────────────────────────────────────────────────────
// The tailnet URL is a promise that ANOTHER device can open it, and nothing local can falsify that:
// the readiness probe dials 127.0.0.1, and loopback never touches the tailnet packet filter. So a
// node whose ACLs grant it nothing passes every local signal — serve mapping present, cert valid,
// `curl https://<name>/` from the same host returns 200 — while no other device can reach it, and
// the failure reads as "server down" (`tailscale ping` still SUCCEEDS: disco pings bypass ACLs).
//
// The packet filter is this node's inbound ACL, so an empty one means deny-all. Note the asymmetry
// and don't let the wording drift past it: empty proves unreachable, but non-empty proves nothing
// (a filter can grant some peer some port and still not grant your phone :443). A smoke alarm, not
// a reachability proof.

/**
 * `tailscale debug netmap` → is this node's inbound packet filter empty (deny-all)? Anything that
 * is not a definite yes is a no, because a false "your ACLs are broken" is worse than silence.
 */
export function packetFilterDeniesAll(netmapJson: string): boolean {
  try {
    const filter = (JSON.parse(netmapJson) as { PacketFilter?: unknown }).PacketFilter;
    return Array.isArray(filter) && filter.length === 0;
  } catch {
    return false;
  }
}

/**
 * {@link packetFilterDeniesAll} over a live netmap. Best-effort by construction: `debug netmap` is
 * an UNDOCUMENTED surface with no stability guarantee, so no CLI, a non-zero exit, unparseable JSON
 * and a missing key all read as "can't tell" — false.
 *
 * Bounded through `timeout(1)` where it exists, because a diagnostic must never hold its caller
 * hostage: a wedged tailscaled (daemon alive, socket accepting, LocalAPI not answering) would
 * otherwise block indefinitely. Stock macOS ships no `timeout`, so there it stays unbounded rather
 * than gaining a dependency for a nice-to-have (the pre-shim collie-ctl.sh).
 */
export function tailnetInboundBlocked(exec: Exec): boolean {
  const tailscale = exec.which("tailscale");
  if (tailscale === null) return false;
  const bounded = exec.which("timeout");
  const r =
    bounded === null
      ? exec.capture("tailscale", ["debug", "netmap"])
      : exec.capture("timeout", ["3", tailscale, "debug", "netmap"]);
  if (!r.found || r.code !== 0) return false;
  return packetFilterDeniesAll(r.stdout);
}

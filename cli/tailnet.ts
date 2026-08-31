import { resolveBridgeHost } from "../bridge/config.ts";
import type { JsonValue } from "../bridge/json.ts";
import { bindIsWildcard } from "../bridge/pack/config.ts";
import type { CliContext, Environment, ServeMode } from "./context.ts";
import { DEFAULT_SERVE_PORT } from "./context.ts";
import type { Exec } from "./sys.ts";

// `tailscale status --json` → this host's name. The shell piped that JSON through an inline
// interpreter one-liner (the pre-shim collie-ctl.sh) — exactly the runtime interpreter
// dependency the compiled binary exists to remove — so the parse moves in-process.

/** `Self.DNSName` with its trailing dot stripped, or null when the JSON says nothing useful. */
export function selfDnsName(statusJson: string): string | null {
  try {
    // SAFETY: the shape `tailscale status --json` documents, and nothing here trusts it further
    // than the `catch` below — every path off `Self.DNSName` is a string method, so a record that
    // disagrees (missing key, number, array) either yields `undefined` or throws inside this `try`,
    // and both read as "no name".
    const data = JSON.parse(statusJson) as { Self?: { DNSName?: string } };
    const name = data.Self?.DNSName;
    if (name === undefined) return null;
    const trimmed = name.replace(/\.$/, "").trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * Every name this node answers to on the tailnet: its MagicDNS name plus its own Tailscale IPs, in
 * that order. IPv6 addresses come back bracketed, because that is the form a `Host` header carries.
 *
 * This is what fills `COLLIE_TAILSCALE_HOSTS`, and it exists because the bridge's Host allowlist
 * fails closed: without it, every normal tailnet install would have to set `COLLIE_PUBLIC_HOSTS` by
 * hand before it answered a single request. Discovery is not a relaxation of the gate — it is the
 * gate being told the truth nobody should have to type.
 *
 * Pure over the JSON so the shapes (no `Self`, no `DNSName`, an empty IP list, garbage) are pinned
 * without a tailnet. Anything it cannot read is simply not a host, and the list comes back shorter.
 */
export function selfHosts(statusJson: string): string[] {
  const out: string[] = [];
  const name = selfDnsName(statusJson);
  if (name !== null) out.push(name);
  try {
    // SAFETY: the shape `tailscale status --json` documents, and nothing here trusts it further
    // than the `catch` below — every path off `TailscaleIPs` is an array iteration and a string
    // method, so a record that disagrees (missing key, numbers, an object) throws inside this `try`
    // and reads as "this node named no addresses". The MagicDNS name is already in `out` by then, so
    // a malformed IP list costs the addresses and never the name.
    const data = JSON.parse(statusJson) as { Self?: { TailscaleIPs?: string[] } };
    // `Array.isArray` and not merely `?? []`: a STRING is iterable, so a record that names one
    // address instead of a list would otherwise contribute one host per character.
    const ips = data.Self?.TailscaleIPs;
    for (const raw of Array.isArray(ips) ? ips : []) {
      const ip = raw.trim();
      if (ip === "") continue;
      // A `Host` header spells an IPv6 address bracketed, and this list is compared against one.
      out.push(ip.includes(":") ? `[${ip}]` : ip);
    }
  } catch {
    // Unreadable JSON says nothing about this node, exactly as it does for the name above.
  }
  return out;
}

/** {@link selfHosts} over a live `tailscale status --json`. A missing or down CLI reads as no hosts. */
export function tailnetHosts(exec: Exec): string[] {
  const r = exec.capture("tailscale", ["status", "--json"]);
  if (!r.found || r.code !== 0) return [];
  return selfHosts(r.stdout);
}

/**
 * The operator's own answer to "what do I type on my phone", or null when they haven't given one.
 * `COLLIE_PUBLIC_URL` is the only truth about the front door whenever Collie didn't publish it —
 * a reverse proxy (Variants C/E), or a `tailscale serve` the operator runs by hand. Collie's own
 * record (`tailscale-managed-handler`) can't answer that: `cmdServe` publishes only the one door it
 * manages — https on 443, or on `COLLIE_SERVE_PORT` — and under `COLLIE_SKIP_SERVE=1` it publishes,
 * and records, nothing at all.
 *
 * A trailing slash is dropped so this reads the same as every URL Collie builds itself.
 */
export function configuredPublicUrl(env: Environment): string | null {
  const raw = env.COLLIE_PUBLIC_URL?.trim();
  if (raw === undefined || raw === "") return null;
  return raw.replace(/\/+$/, "");
}

/**
 * The URL to open. `https://<name>` in https mode (tailscale terminates TLS on 443),
 * `http://<name>:<port>` in http mode, and a loopback URL that SAYS why when the tailnet name is
 * unavailable — an operator on Headscale reads that line to find out their setup isn't published.
 *
 * `servePort` is the https listener (`COLLIE_SERVE_PORT`, default 443) and only ever shows up as a
 * suffix when it is not 443: an https URL carrying `:443` would be the same address typed longer,
 * and every line Collie prints for a default install must read as it always did.
 */
export function bridgeUrlFrom(
  name: string | null,
  mode: ServeMode,
  port: number,
  servePort: number,
): string {
  if (name === null) return `http://127.0.0.1:${port} (Tailscale name unavailable)`;
  if (mode === "http") return `http://${name}:${port}`;
  return servePort === DEFAULT_SERVE_PORT ? `https://${name}` : `https://${name}:${servePort}`;
}

/**
 * The address this machine's own bridge answers on — the one it actually BOUND, never a hardcoded
 * loopback string.
 *
 * `COLLIE_HOST` moves the bind (`resolveBridgeHost`), and a peer is routinely bound to a tailnet or
 * LAN address with nothing at all on loopback (ADR 0013's F3 amendment: `Bun.serve` takes one
 * hostname, and it is the operator's). The `local` row and the `COLLIE_SKIP_SERVE` line used to
 * print `127.0.0.1` regardless, so on such a host every "here is where it is" line named a port that
 * refuses to connect — while the readiness probe two lines up, which resolves the bind properly,
 * reported the machine as UP. One banner, two answers.
 *
 * A WILDCARD bind is shown as loopback, and that is not a fudge: `0.0.0.0`/`::`/empty means *every*
 * interface, so loopback is one of the addresses it answers on and the only one this machine can
 * promise reaches itself. `cli/doctor.ts` dials it the same way for the same reason.
 */
export function dialableBridgeHost(env: Environment): string {
  const host = resolveBridgeHost(env);
  return bindIsWildcard(host) ? "127.0.0.1" : host.trim();
}

/** {@link dialableBridgeHost} as `host:port`, with an IPv6 literal bracketed for a URL. */
export function localBridgeHostPort(env: Environment, port: number): string {
  const host = dialableBridgeHost(env);
  // A bare IPv6 address in an authority is ambiguous with the port separator — `[::1]:8787`. Only a
  // literal needs it: a name or an IPv4 address carries no colon, and an already-bracketed value is
  // left as the operator wrote it.
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${authority}:${port}`;
}

/** {@link localBridgeHostPort} as the URL a browser on this machine would open. */
export function localBridgeUrl(env: Environment, port: number): string {
  return `http://${localBridgeHostPort(env, port)}`;
}

/** {@link selfDnsName} over a live `tailscale status --json`. A missing CLI reads as no name. */
export function tailnetName(exec: Exec): string | null {
  const r = exec.capture("tailscale", ["status", "--json"]);
  if (!r.found || r.code !== 0) return null;
  return selfDnsName(r.stdout);
}

/**
 * The one resolver behind every "where is it" answer — `url`, the `status` banner, `serve`'s `open:`
 * line and the `qr` code. An explicit `COLLIE_PUBLIC_URL` wins, because it is the operator telling
 * Collie something Collie cannot observe; only without one is the tailnet name inferred.
 */
export function bridgeUrl(exec: Exec, ctx: CliContext): string {
  return (
    configuredPublicUrl(ctx.env) ??
    bridgeUrlFrom(tailnetName(exec), ctx.serveMode, ctx.port, ctx.servePort)
  );
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
    // SAFETY: `JSON.parse` output IS a JsonValue by construction, and the only thing read off it is
    // whether `PacketFilter` is an empty array — re-checked on the next line, never trusted.
    const filter = (JSON.parse(netmapJson) as { PacketFilter?: JsonValue }).PacketFilter;
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

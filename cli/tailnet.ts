import type { JsonValue } from "../bridge/json.ts";
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

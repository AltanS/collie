import { homedir } from "node:os";
import { join } from "node:path";

// All bridge configuration, resolved once at startup. Env-driven so the systemd unit and the
// plugin launcher can configure it without code changes. Defaults are safe for a single-user,
// tailnet-only deployment.

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface Config {
  /** Path to Herdr's control socket. A non-Herdr-launched daemon must discover this itself. */
  socketPath: string;
  /** TCP port the bridge listens on (loopback only). `tailscale serve` proxies to it. */
  port: number;
  /**
   * Bind host. ALWAYS loopback by default — binding 0.0.0.0 would make the Tailscale identity
   * check meaningless (see ARCHITECTURE.md §6). Override only if you know exactly why.
   */
  host: string;
  /** Poll cadence for the state engine, ms. */
  pollMs: number;
  /** How many lines of scrollback to pull for the agent detail view. */
  readLines: number;
  /** Key sequence sent to submit a reply after the text (agent-dependent; see HERDR_API.md). */
  submitKeys: string[];
  /**
   * Tailscale identity gate. If set, any request carrying a `Tailscale-User-Login` header
   * (injected by `tailscale serve`) must match this login — a mismatching tailnet user is
   * rejected. A request with no such header still passes (direct-loopback callers don't get one),
   * so this narrows *which* user is trusted rather than mandating the header. Empty = trust any
   * loopback caller (fine when only tailscaled can reach the port).
   */
  trustedUser: string;
  /**
   * Per-device authorisation. Name of a request header carrying an opaque device identifier,
   * injected by a trusted upstream reverse proxy. Empty = the feature is off (no behaviour change).
   * When set, devices whose header value isn't in {@link deviceAllowlist} are read-only. See
   * `deviceAuth()` in server.ts for the full matrix. The header is trusted only because the bridge
   * binds loopback behind the proxy — a direct client can't set it (same trust basis as trustedUser).
   */
  deviceHeader: string;
  /**
   * Device identifiers permitted to perform sensitive actions (typing into agent terminals,
   * structural creates). Everything else carrying the header is read-only. To revoke a device,
   * drop its value from this list and restart. Ignored when {@link deviceHeader} is empty.
   */
  deviceAllowlist: string[];
  /** Extra allowed request origins beyond localhost (e.g. your MagicDNS https origin). */
  allowedOrigins: string[];
  /** Web Push (VAPID). All three required to enable push; otherwise push is disabled. */
  vapidPublic: string;
  vapidPrivate: string;
  vapidSubject: string;
  /** Where to persist push subscriptions and other runtime state. */
  stateDir: string;
}

export function loadConfig(): Config {
  const stateDir =
    process.env.HERDR_PLUGIN_STATE_DIR ??
    process.env.COLLIE_STATE_DIR ??
    join(homedir(), ".local", "state", "collie");

  const submitKeys = envList("COLLIE_SUBMIT_KEYS");

  return {
    socketPath: process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config", "herdr", "herdr.sock"),
    port: envInt("COLLIE_PORT", 8787),
    host: process.env.COLLIE_HOST ?? "127.0.0.1",
    pollMs: envInt("COLLIE_POLL_MS", 1500),
    readLines: envInt("COLLIE_READ_LINES", 200),
    submitKeys: submitKeys.length ? submitKeys : ["Enter"],
    trustedUser: process.env.COLLIE_TRUSTED_USER ?? "",
    deviceHeader: (process.env.COLLIE_DEVICE_HEADER ?? "").trim(),
    deviceAllowlist: envList("COLLIE_DEVICE_ALLOWLIST"),
    allowedOrigins: envList("COLLIE_ALLOWED_ORIGINS"),
    vapidPublic: process.env.COLLIE_VAPID_PUBLIC ?? "",
    vapidPrivate: process.env.COLLIE_VAPID_PRIVATE ?? "",
    vapidSubject: process.env.COLLIE_VAPID_SUBJECT ?? "mailto:admin@example.com",
    stateDir,
  };
}

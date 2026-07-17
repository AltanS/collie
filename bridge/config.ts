import { homedir } from "node:os";
import { join } from "node:path";

// All bridge configuration, resolved once at startup. Env-driven so the systemd unit and the
// plugin launcher can configure it without code changes. Defaults are safe for a single-user,
// tailnet-only deployment.

/**
 * Read an integer env var, falling back to `fallback` (with one warning line) on anything invalid:
 * an empty/unset value, non-integer garbage (`parseInt("123abc")` used to sneak `123` through — a
 * strict regex rejects it), or a value outside the optional `[min, max]` bounds. Keeping bad config
 * from silently becoming a nonsense number (a negative poll interval, port 0) is the whole point.
 */
function envInt(
  name: string,
  fallback: number,
  opts: { min?: number; max?: number } = {},
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    console.warn(`[config] ${name}="${raw}" is not an integer — using default ${fallback}`);
    return fallback;
  }
  const n = Number(trimmed);
  const { min, max } = opts;
  if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
    console.warn(`[config] ${name}=${n} is out of the allowed range — using default ${fallback}`);
    return fallback;
  }
  return n;
}

function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Read a boolean env var. Empty/unset → `fallback`. `off`/`0`/`false`/`no` → false; `on`/`1`/`true`/
 * `yes` → true (case-insensitive); anything else falls back with a warning. Used for feature toggles
 * that default on, where a typo silently flipping the feature would be surprising.
 */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["off", "0", "false", "no"].includes(v)) return false;
  if (["on", "1", "true", "yes"].includes(v)) return true;
  console.warn(`[config] ${name}="${raw}" is not a boolean — using default ${fallback}`);
  return fallback;
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
  /** Poll cadence for the state engine, ms. Also the fast fallback cadence when the event stream is down. */
  pollMs: number;
  /**
   * Relaxed safety-net poll cadence, ms, used while the events.subscribe stream is healthy. Events
   * poke immediate re-polls, so this interval only backstops a missed poke — a miss costs at most
   * one of these, never correctness. Falls back to {@link pollMs} the moment the stream drops.
   */
  pollIdleMs: number;
  /**
   * Debounce window before a blocked/done transition becomes a push, ms. An agent that resolves
   * within this window (you handled it at your desk) never notifies; one that fires is retracted
   * when it later resolves. See NotificationCoordinator. 0 = notify on the next tick (no debounce).
   */
  notifyDelayMs: number;
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
  /**
   * Host-header allowlist (`host` or `host:port` values). When non-empty, the operator has opted
   * in to strict Host validation: any request whose `Host` header isn't a loopback form, one of
   * these, or a host parsed from {@link allowedOrigins} is rejected before the Origin check. This
   * closes the DNS-rebinding hole (Host==Origin==evil.com would otherwise pass), which matters most
   * under `COLLIE_SERVE_MODE=http` (no TLS). Empty = validation off (legacy behaviour) — set this
   * to your MagicDNS name (`collie.<tailnet>.ts.net`), especially in http serve mode.
   */
  publicHosts: string[];
  /** Web Push (VAPID). All three required to enable push; otherwise push is disabled. */
  vapidPublic: string;
  vapidPrivate: string;
  vapidSubject: string;
  /** Where to persist push subscriptions and other runtime state. */
  stateDir: string;
  /**
   * Multi-session support. When on (default), the bridge fronts every running herdr session it
   * discovers under the config root, not just {@link socketPath}, and the UI gains a session
   * switcher. Off (`off`/`0`/`false`) pins the bridge to the primary session only — no discovery,
   * exactly the pre-feature behaviour. Client-supplied session names only ever select an
   * already-discovered session; they never build a filesystem path.
   */
  multiSession: boolean;
  /**
   * Whether `tailscale serve` is bypassed (COLLIE_SKIP_SERVE=1) because an operator-run reverse
   * proxy (Caddy/Nginx) fronts the loopback bridge instead. The bridge itself handles every request
   * identically either way — this flag only informs the startup warnings: without `tailscale serve`
   * in front, the `Tailscale-User-Login` header is never injected, so {@link trustedUser} is inert
   * and per-device auth ({@link deviceHeader}) becomes the way to gate writes (README → Variant C).
   */
  skipServe: boolean;
}

export function loadConfig(): Config {
  const stateDir =
    process.env.HERDR_PLUGIN_STATE_DIR ??
    process.env.COLLIE_STATE_DIR ??
    join(homedir(), ".local", "state", "collie");

  const submitKeys = envList("COLLIE_SUBMIT_KEYS");

  return {
    socketPath: process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config", "herdr", "herdr.sock"),
    port: envInt("COLLIE_PORT", 8787, { min: 1, max: 65535 }),
    host: process.env.COLLIE_HOST ?? "127.0.0.1",
    pollMs: envInt("COLLIE_POLL_MS", 1500, { min: 250 }),
    pollIdleMs: envInt("COLLIE_POLL_IDLE_MS", 12_000, { min: 1000 }),
    notifyDelayMs: envInt("COLLIE_NOTIFY_DELAY_MS", 30_000, { min: 0 }),
    readLines: envInt("COLLIE_READ_LINES", 200, { min: 1 }),
    submitKeys: submitKeys.length ? submitKeys : ["Enter"],
    trustedUser: process.env.COLLIE_TRUSTED_USER ?? "",
    deviceHeader: (process.env.COLLIE_DEVICE_HEADER ?? "").trim(),
    deviceAllowlist: envList("COLLIE_DEVICE_ALLOWLIST"),
    allowedOrigins: envList("COLLIE_ALLOWED_ORIGINS"),
    publicHosts: envList("COLLIE_PUBLIC_HOSTS"),
    vapidPublic: process.env.COLLIE_VAPID_PUBLIC ?? "",
    vapidPrivate: process.env.COLLIE_VAPID_PRIVATE ?? "",
    vapidSubject: process.env.COLLIE_VAPID_SUBJECT ?? "mailto:admin@example.com",
    stateDir,
    multiSession: envBool("COLLIE_MULTI_SESSION", true),
    skipServe: envBool("COLLIE_SKIP_SERVE", false),
  };
}

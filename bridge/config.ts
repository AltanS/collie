import { homedir } from "node:os";
import { join } from "node:path";

import type { AuditContent } from "./audit.ts";
import type { DialMode } from "./dial.ts";
import type { JournalRoots } from "./journal/registry.ts";

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
 * A journal root setting: a list of directories, or `fallback` when unset.
 *
 * Comma-separated, like every other list Collie reads ({@link envList}) — deliberately NOT `PATH`'s
 * separator, which is `:` on Unix and `;` on Windows and would make the same setting mean different
 * things on the two platforms this bridge supports. One path stays one path, so an existing value
 * parses to exactly what it always meant.
 */
function envRoots(name: string, fallback: string): string[] {
  const list = envList(name);
  return list.length > 0 ? list : [fallback];
}

/**
 * Read an env var constrained to a fixed set of string values, falling back (with a warning) on
 * anything not in `allowed`. Empty/unset → `fallback`. Case-insensitive.
 */
function envEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  const match = allowed.find((a) => a.toLowerCase() === v);
  if (match !== undefined) return match;
  console.warn(`[config] ${name}="${raw}" is not one of ${allowed.join("|")} — using default ${fallback}`);
  return fallback;
}

/**
 * Read a boolean env var. Empty/unset → `fallback`. `off`/`0`/`false`/`no` → false; `on`/`1`/`true`/
 * `yes` → true (case-insensitive); anything else falls back with a warning.
 *
 * Exported so mode-scoped config (`bridge/pack/config.ts`) parses its env in exactly this style
 * rather than growing a second, subtly different reader. The env source is a parameter so a caller
 * can drive it purely; it defaults to `process.env`, which is how everything in this file reads.
 */
export function envBool(
  name: string,
  fallback: boolean,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[name];
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
  /**
   * Which dialer opens that socket. `auto` (the default) is correct everywhere: `node:net` on
   * Windows, where herdr's socket is a named pipe, and Bun's native transport elsewhere. Forcing
   * `net` on Linux/macOS exercises the Windows dial path against the real socket — the only way to
   * run that code without a Windows box. Set via `COLLIE_HERDR_DIAL`.
   *
   * Optional so it stays out of unrelated test fixtures: `loadConfig` always resolves it, and an
   * absent value means the same thing as `auto` at the one place it's consumed.
   */
  dialMode?: DialMode;
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
  /**
   * Serve agent conversation history from the agent's own on-disk session log. This is the only
   * way to get scrollback for most agent panes at all — they run on the terminal's alternate
   * screen, which has no scrollback ring, so Herdr retains nothing behind the viewport (see
   * journal/claude.ts). Off disables the feature and its route wholesale, for every harness.
   */
  transcript: boolean;
  /**
   * Where each harness keeps its session logs — one directory or several, searched in order. Every
   * read is confined to the root it was found under, after symlink resolution, so these double as the
   * security boundary for a feature that touches the filesystem — override only to relocate (or add)
   * a non-default agent home, never from a request.
   */
  journalRoots: JournalRoots;
  /** Key sequence sent to submit a reply after the text (agent-dependent; see HERDR_API.md). */
  submitKeys: string[];
  /**
   * Where the operator's Agent-commands rows live — `commands.toml` in the same dir as their
   * `.env`. Read at request time behind an mtime check (bridge/operator-commands.ts), so it is
   * resolved here but never read here.
   */
  commandsFile: string;
  /**
   * Where the operator's Keys-tray preset rows live — `keys.toml`, the sibling of `commands.toml`
   * in the same dir, read the same way (bridge/operator-keys.ts) and likewise never read here.
   */
  keysFile: string;
  /**
   * Tailscale identity gate. If set, any request carrying a `Tailscale-User-Login` header
   * (injected by `tailscale serve`) must match this login — a mismatching tailnet user is
   * rejected. A request with no such header still passes (direct-loopback callers don't get one),
   * so this narrows *which* user is trusted rather than mandating the header. Empty = trust any
   * loopback caller (fine when only tailscaled can reach the port).
   */
  trustedUser: string;
  /**
   * How much of each value's content the audit trail keeps — see {@link AuditContent} in audit.ts
   * for what `none` does and does not redact.
   */
  auditContent: AuditContent;
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
   * and per-device auth ({@link deviceHeader}) becomes the way to gate writes (DEPLOYMENT.md → Variant C).
   */
  skipServe: boolean;
}

/**
 * The loopback port the bridge binds. Exported because the CLI writes it into the generated service
 * unit and into `status` — one source of truth, so a default changed here can't leave the unit and
 * the process disagreeing about where Collie is.
 */
export const DEFAULT_PORT = 8787;

/**
 * The address the bridge actually binds: an absent `COLLIE_HOST` resolves to loopback, anything set
 * is used verbatim (empty string included — that's the wildcard-bind case `bindIsWildcard` names).
 * Pure and exported for the same reason as {@link resolveStateDir}: `cli/doctor.ts`'s bind check and
 * the `collie start`/`status` banner's readiness probe (`cli/lifecycle.ts`) both need the bridge's
 * real bind from their own merged `.env`, not a re-derived guess that could drift from this one.
 */
export function resolveBridgeHost(env: Record<string, string | undefined> = process.env): string {
  return env.COLLIE_HOST ?? "127.0.0.1";
}

/**
 * herdr's default socket location: `~/.config/herdr/herdr.sock` on Unix, `%APPDATA%\herdr\herdr.sock`
 * on Windows (the Windows beta keeps its config root under AppData\Roaming). Pure so both branches
 * are unit-testable on any platform.
 */
export function defaultSocketPath(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  if (platform === "win32") {
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, "herdr", "herdr.sock");
  }
  return join(home, ".config", "herdr", "herdr.sock");
}

/**
 * Where runtime state lives: uploads, `audit.log`, `push-subscriptions.json`, `snooze.json` — and the
 * pack trust store. Herdr's injected dir wins, then the explicit override, then the user state dir.
 *
 * Pure and exported because the CLI resolves the same directory from its own `.env`-merged
 * environment (`cli/context.ts`): the pack verbs write the trust store the bridge reads, so the two
 * must land on the same path or an enrollment would be invisible to the running service. It names no
 * key `loadConfig` did not already name — the solo baseline's env-key list is unchanged by it.
 */
export function resolveStateDir(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  return env.HERDR_PLUGIN_STATE_DIR ?? env.COLLIE_STATE_DIR ?? join(home, ".local", "state", "collie");
}

export function loadConfig(): Config {
  const stateDir = resolveStateDir();

  const submitKeys = envList("COLLIE_SUBMIT_KEYS");

  // The operator's config dir — where their `.env` lives, and now their `commands.toml` beside it.
  // Resolved exactly the way scripts/collie-ctl.sh resolves it MINUS the `herdr` shell-out: the
  // launcher passes HERDR_PLUGIN_CONFIG_DIR into the unit (and the launchd plist) precisely so this
  // process never has to ask the CLI, and the two entry points must not disagree about which dir
  // that is. ~/.config/collie is the same last-resort default the shim ends on.
  const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR ?? join(homedir(), ".config", "collie");

  return {
    socketPath: process.env.HERDR_SOCKET_PATH ?? defaultSocketPath(),
    dialMode: envEnum("COLLIE_HERDR_DIAL", ["auto", "net", "bun"] as const, "auto"),
    port: envInt("COLLIE_PORT", DEFAULT_PORT, { min: 1, max: 65535 }),
    host: resolveBridgeHost(),
    pollMs: envInt("COLLIE_POLL_MS", 1500, { min: 250 }),
    pollIdleMs: envInt("COLLIE_POLL_IDLE_MS", 12_000, { min: 1000 }),
    notifyDelayMs: envInt("COLLIE_NOTIFY_DELAY_MS", 30_000, { min: 0 }),
    readLines: envInt("COLLIE_READ_LINES", 200, { min: 1 }),
    transcript: envBool("COLLIE_TRANSCRIPT", true),
    journalRoots: {
      // COLLIE_TRANSCRIPT_ROOT predates the per-harness split and meant Claude's root, so it keeps
      // meaning exactly that — an existing deployment's env keeps working untouched. It takes SEVERAL
      // roots (comma-separated) because `CLAUDE_CONFIG_DIR` gives each Claude profile its own
      // projects tree, and a herd routinely mixes them (issue #92); one value is still one root.
      claude: envRoots("COLLIE_TRANSCRIPT_ROOT", join(homedir(), ".claude", "projects")),
      // Each harness's own home var is honoured first, so relocating the agent relocates its journal
      // without a second Collie setting to keep in sync. The Collie override takes a list too — the
      // multi-home case isn't Claude's alone, and one setting shouldn't behave differently per agent.
      codex: envRoots(
        "COLLIE_CODEX_ROOT",
        join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions"),
      ),
      pi: envRoots(
        "COLLIE_PI_ROOT",
        join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sessions"),
      ),
      // OpenCode keeps one SQLite database at the top of its XDG data dir, not per-session files.
      opencode: envRoots(
        "COLLIE_OPENCODE_ROOT",
        join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode"),
      ),
    },
    submitKeys: submitKeys.length ? submitKeys : ["Enter"],
    commandsFile: join(configDir, "commands.toml"),
    keysFile: join(configDir, "keys.toml"),
    trustedUser: process.env.COLLIE_TRUSTED_USER ?? "",
    auditContent: envEnum("COLLIE_AUDIT_CONTENT", ["preview", "none"] as const, "preview"),
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

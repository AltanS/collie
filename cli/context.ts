import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_PORT, defaultSocketPath, resolveStateDir } from "../bridge/config.ts";
import { pluginRoot } from "../bridge/root.ts";
import { instanceSuffixOf, managedHandlerPath, type ServeMode } from "../bridge/front-door.ts";
import { findTool } from "./tools.ts";

export const PLUGIN_ID = "herdr.collie";

/**
 * Everything a verb needs about *where things are*, resolved exactly once and passed down. No verb
 * module reads `process.env` on its own — a single resolution is what keeps the two entry points
 * (Herdr action vs a direct call) from reading different `.env` files, which is the bug
 * the pre-shim `collie-ctl.sh` recorded.
 */
export interface CliContext {
  /** The Collie checkout. */
  root: string;
  /**
   * The instance suffix from `COLLIE_INSTANCE`, or `null` for the one-and-only instance a host has
   * always had. `null` is not a default that behaves like `""` — it is the ONLY value that produces
   * today's names (`collie.service`, `tailscale-managed-handler`, `collie.pid`), byte for byte.
   */
  instance: string | null;
  /** Where `.env` and the ownership record live. */
  configDir: string;
  /** Resolved home dir — `$HOME` when set, the passwd entry otherwise (there may be no env). */
  home: string;
  /** `.env`-merged environment. The one env any verb should consult. */
  env: Environment;
  port: number;
  serveMode: ServeMode;
  /**
   * The tailnet listener port the https front door is published on — `443` unless the operator set
   * `COLLIE_SERVE_PORT`. Inert in http mode, where the listener is always {@link CliContext.port}.
   *
   * Resolved leniently here (an unusable value reads as 443) so no unrelated verb dies on a typo;
   * `cmdServe` re-reads the raw setting through {@link parseServePort} and REFUSES to publish on a
   * value it cannot trust. One parser, two policies — see {@link parseServePort}.
   */
  servePort: number;
  socket: string;
  /** The single managed `tailscale serve` mapping's ownership record. */
  handlerFile: string;
  /**
   * Runtime state — the same directory the bridge resolves (`bridge/config.ts`'s `resolveStateDir`),
   * so the pack trust store a verb writes is the one the running service reads.
   */
  stateDir: string;
}

// Defined beside the ownership record that stores it (`bridge/front-door.ts`), so the record's
// `mode` field and this context's `serveMode` are one type rather than two that happen to agree.
export type { ServeMode };

/**
 * A process environment: variable names to values, an unset name reading `undefined`. Named rather
 * than written out as a bare dictionary at each site, so the CLI has one word for "the env".
 */
export interface Environment {
  [name: string]: string | undefined;
}

/**
 * Environment variables with a value for every name: a parsed `.env`, or the exact set a
 * supervised process is launched with — as opposed to {@link Environment}, where a name may be unset.
 */
export interface EnvVars {
  [name: string]: string;
}

// ── .env ─────────────────────────────────────────────────────────────────────
// Parsed in process, never `source`d. The shell had to `. "${CONFIG_DIR}/.env"`, which executes it:
// a `bun()` function defined in there would shadow the real binary and poison every later lookup
// (the hazard the pre-shim collie-ctl.sh worked around). Parsing removes the hazard outright — a
// `.env` can now only set variables.

/**
 * The two filesystem facts the permission guard needs. A seam, so its truth table is unit-tested
 * without a real file whose mode the test's own umask would decide.
 */
export interface EnvFilePerms {
  /** The file's permission bits (`mode & 0o777`), or `null` when it cannot be stated. */
  mode(path: string): number | null;
  /** Tighten it to `0600`. `false` when the chmod failed — a file owned by someone else. */
  tighten(path: string): boolean;
}

/** The modes a `.env` may already carry without anyone touching it: owner-only, read or read/write. */
const PRIVATE_ENV_MODES = new Set([0o600, 0o400]);

/**
 * Hold `.env` to owner-only, tightening it in place when it is not — and say so either way.
 *
 * This file holds `COLLIE_VAPID_PRIVATE` (a Web Push signing key) and, on a shared host, the
 * settings that decide who may type into this operator's terminals. A group- or world-readable one
 * is a credential leak that nothing else in Collie can detect: `EnvironmentFile=` and this CLI both
 * read it happily at any mode. So the read path is where it is checked.
 *
 * **Warn, never refuse.** A `.env` this process cannot chmod belongs to another user, and a Collie
 * that would not start because of it is a Collie the operator cannot use to fix it.
 *
 * Returns the line for stderr, or `null` when there was nothing to say.
 */
export function tightenEnvFile(path: string, perms: EnvFilePerms): string | null {
  const mode = perms.mode(path);
  if (mode === null || PRIVATE_ENV_MODES.has(mode)) return null;
  const shown = mode.toString(8).padStart(3, "0");
  return perms.tighten(path)
    ? `warn: ${path} was mode ${shown} (expected 600); tightened it to 600.`
    : `warn: ${path} is mode ${shown} (expected 600) and could not be tightened; it may be readable by other users.`;
}

/**
 * Parse `KEY=value` lines the way `set -a; . file` would for the assignment-only subset: `export`
 * prefixes, `#` comments, blank lines, and single/double quoted values (double quotes keep the
 * common `\n`/`\t`/`\"`/`\\` escapes; single quotes are literal). Anything that is not an
 * assignment is ignored rather than executed.
 */
export function parseEnvFile(text: string): EnvVars {
  const out: EnvVars = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m === null) continue;
    const key = m[1]!;
    let value = m[2]!;
    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value
        .slice(1, -1)
        .replace(/\\([nrt"\\$`])/g, (_all, c: string) =>
          c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c,
        );
    } else {
      // Unquoted: strip a trailing inline comment the way the shell would only after whitespace.
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash);
      value = value.trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * `text` with every name in `vars` assigned: an assignment already there is REPLACED where it
 * stands, a new one is appended.
 *
 * In place rather than appended-and-shadowed, because a `.env` is a file the operator reads and
 * edits: two `COLLIE_MUX=` lines where the last one silently wins is a file that lies to whoever
 * opens it next. Comments, blank lines and every other setting survive untouched — this is the only
 * writer of a file nobody else in Collie writes, and it must not become a rewriter of one.
 */
export function upsertEnvVars(text: string, vars: EnvVars): string {
  const lines = text === "" ? [] : text.split("\n");
  const pending = new Map(Object.entries(vars));
  const written = lines.map((line) => {
    const m = /^(\s*)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    const key = m?.[2];
    if (key === undefined || !pending.has(key)) return line;
    const value = pending.get(key)!;
    pending.delete(key);
    return `${m?.[1] ?? ""}${key}=${quoteEnvValue(value)}`;
  });
  if (pending.size > 0) {
    // Past the last line that says anything, so an appended key lands under the file's content
    // rather than under whatever blank lines the last editor left at the bottom.
    written.length = written.findLastIndex((line) => line.trim() !== "") + 1;
    for (const [key, value] of pending) written.push(`${key}=${quoteEnvValue(value)}`);
  }
  if (written.length === 0) return "";
  // Exactly one trailing newline, whatever the file arrived with: the next append must not land on
  // the end of somebody else's assignment.
  return `${written.join("\n").replace(/\n+$/u, "")}\n`;
}

/** The bare characters {@link parseEnvFile} reads back unquoted, exactly as it reads them. */
const BARE_ENV_VALUE = /^[A-Za-z0-9_@%+=:,./-]*$/;

/**
 * A value as {@link parseEnvFile} would read it back — the round trip is the contract, and
 * `context.test.ts` pins it. Double quotes rather than single, because the escapes the parser
 * already understands live in that branch and a single-quoted value has no way to carry a `'`.
 */
function quoteEnvValue(value: string): string {
  if (BARE_ENV_VALUE.test(value)) return value;
  const escaped = value.replaceAll(/([\\"$`])/gu, "\\$1").replaceAll("\n", "\\n").replaceAll("\r", "\\r");
  return `"${escaped}"`;
}

// ── Config dir ───────────────────────────────────────────────────────────────

export interface ConfigDirDeps {
  env: Environment;
  home: string;
  fileExists: (p: string) => boolean;
  /** `herdr plugin config-dir <id>`, or null when herdr is absent / said nothing. */
  askHerdr: () => string | null;
}

export interface ConfigDirResult {
  dir: string;
  /** Diagnostic for stderr — a legacy `.env` that is now being ignored. */
  note: string | null;
}

/**
 * Injected env → the Herdr CLI's answer → Herdr's conventional path → `~/.config/collie`, where
 * every step past the injected one counts ONLY when that directory actually holds a `.env`. Mirrors
 * the pre-shim `collie-ctl.sh` including the legacy-`.env`-ignored note, so config applied one way
 * is never silently dropped the other.
 *
 * **A dir with no `.env` is not in use, and may not out-rank one that is.** The `.env` test used to
 * apply to the conventional path and not to Herdr's answer, so a `herdr` binary merely present on
 * PATH captured the config dir of a Collie it does not manage. Nothing changes for a real
 * Herdr-managed install, where the plugin dir is the one holding the `.env`.
 *
 * **A named instance short-circuits the middle of that chain.** `deps.env` is the PROCESS env, read
 * before any `.env` merge, so a `COLLIE_INSTANCE` here is the operator's own — see the amendment at
 * "The instance suffix" below for why it may only DISCOVER the suffixed conventional dir, and must
 * refuse rather than resolve to another instance's files.
 */
export function resolveConfigDir(deps: ConfigDirDeps): ConfigDirResult {
  const legacy = join(deps.home, ".config", "collie");
  const conventionalFor = (suffix: string): string =>
    join(deps.home, ".config", "herdr", "plugins", "config", `${PLUGIN_ID}${suffix}`);
  // Shape-checked, not resolved: an unusable value falls through to the pre-instance behaviour so
  // that `resolveInstance` stays the single source of the "not a usable instance name" refusal.
  const raw = deps.env.COLLIE_INSTANCE?.trim();
  const instance = raw !== undefined && INSTANCE_PATTERN.test(raw) ? raw : null;
  const dir = pick();
  const note =
    // Silent for a named instance: the legacy `.env` belongs to the host's first Collie, and telling
    // a second instance to move it into its own dir would be advice to merge two configs.
    instance === null && dir !== legacy && deps.fileExists(join(legacy, ".env"))
      ? `note: ignoring legacy ${join(legacy, ".env")} — config now lives in ${join(dir, ".env")} (move it there).`
      : null;
  return { dir, note };

  function pick(): string {
    const injected = deps.env.HERDR_PLUGIN_CONFIG_DIR?.trim();
    if (injected) return injected;
    if (instance !== null) {
      // Not `askHerdr()`: herdr only knows the unsuffixed plugin's dir, which is another instance's.
      const own = conventionalFor(instanceSuffix(instance));
      if (deps.fileExists(join(own, ".env"))) return own;
      throw new Error(
        `COLLIE_INSTANCE="${instance}" but no config at ${join(own, ".env")} — create it, or pass ` +
          "HERDR_PLUGIN_CONFIG_DIR explicitly. Refusing to fall back to another instance's config.",
      );
    }
    // Herdr's answer wins only when it is IN USE. A `herdr` binary anywhere on PATH answers this
    // question for every Collie on the host, including one Herdr does not manage — and trusting it
    // unconditionally made a binary install ignore the `~/.config/collie/.env` its own installer
    // had just told the operator to write, under a note that called that file legacy.
    const asked = deps.askHerdr()?.trim();
    if (asked && deps.fileExists(join(asked, ".env"))) return asked;
    const conventional = conventionalFor("");
    if (deps.fileExists(join(conventional, ".env"))) return conventional;
    if (deps.fileExists(join(legacy, ".env"))) return legacy;
    // No `.env` anywhere: nothing is in use, so there is nothing to get wrong. Herdr's answer is
    // still the best guess at where a config would go on a host that runs Herdr.
    return asked || legacy;
  }
}

// ── Version ──────────────────────────────────────────────────────────────────

// Re-exported, not defined here. The resolver moved to `bridge/version.ts` when `hello` had to
// answer with this machine's version (PACK_PROTOCOL.md §7.1): the bridge cannot import from `cli/`,
// and two implementations that agree today are not the guarantee the spec asks for. Every existing
// caller keeps importing it from here.
export { collieVersion, collieVersionBare, collieVersionFrom } from "../bridge/version.ts";

/** {@link EnvFilePerms} against the real filesystem. */
const diskEnvPerms: EnvFilePerms = {
  mode(path) {
    try {
      return statSync(path).mode & 0o777;
    } catch {
      return null;
    }
  },
  tighten(path) {
    try {
      chmodSync(path, 0o600);
      return true;
    } catch {
      return false;
    }
  },
};

/** File contents, or `null` when missing/unreadable. */
function readIfPresent(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

// ── Derived settings ─────────────────────────────────────────────────────────

/**
 * `COLLIE_PORT` → port, `COLLIE_SERVE_MODE` → https|http, `COLLIE_SERVE_PORT` → the https listener,
 * `HERDR_SOCKET_PATH` → socket.
 *
 * The port and socket defaults come from `bridge/config.ts`, not from a second copy: the CLI writes
 * them into the generated unit and the bridge reads them at boot, so a divergence would put the
 * service on one port and the banner on another.
 */
export function deriveSettings(
  env: Environment,
  home: string,
): Pick<CliContext, "port" | "serveMode" | "servePort" | "socket"> {
  const rawPort = env.COLLIE_PORT?.trim();
  const port = rawPort && /^\d+$/.test(rawPort) ? Number(rawPort) : DEFAULT_PORT;
  const mode = env.COLLIE_SERVE_MODE?.trim();
  return {
    port,
    serveMode: mode === "http" ? "http" : "https",
    servePort: effectiveServePort(env),
    socket: env.HERDR_SOCKET_PATH?.trim() || defaultSocketPath(process.platform, env, home),
  };
}

// ── COLLIE_SERVE_PORT ────────────────────────────────────────────────────────
// Several developers sharing one host each want their own tailnet URL, and a tailnet name is per
// host, not per user — so the second Collie needs a listener port of its own. `tailscale serve
// --https=<port>` takes any port (only `funnel` is restricted to 443/8443/10000), so this is still
// THE one managed front door (ADR 0001): only its port is now the operator's to choose.
//
// It is deliberately https-only. In http mode the listener IS the bridge port — that is what
// `COLLIE_PORT` already means — so a second port there would be two answers to one question, and
// `cmdServe` refuses the combination rather than picking one.

/** The port `tailscale serve` terminates TLS on unless the operator names another. */
export const DEFAULT_SERVE_PORT = 443;

/**
 * `COLLIE_SERVE_PORT` → the https listener port, or the reason it cannot be used.
 *
 * The one parser, read by two policies. {@link deriveSettings} takes the lenient half so that `url`,
 * `status`, `qr` and `doctor` keep working through a typo; `cmdServe` takes the strict half and
 * refuses to publish, because a front door on a port the operator did not ask for is a door they do
 * not know is open.
 */
export function parseServePort(
  env: Environment,
): { ok: true; port: number } | { ok: false; message: string } {
  const raw = env.COLLIE_SERVE_PORT?.trim();
  if (raw === undefined || raw === "") return { ok: true, port: DEFAULT_SERVE_PORT };
  const port = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return {
      ok: false,
      message: `COLLIE_SERVE_PORT="${raw}" is not a usable port — a whole number from 1 to 65535.`,
    };
  }
  return { ok: true, port };
}

/** {@link parseServePort}'s lenient half: an unusable value reads as the default. */
export function effectiveServePort(env: Environment): number {
  const parsed = parseServePort(env);
  return parsed.ok ? parsed.port : DEFAULT_SERVE_PORT;
}

// ── The instance suffix ──────────────────────────────────────────────────────
// Two Collies on one host — a stable one and a next-major one being shaken out beside it — need two
// of everything the CLI names: a unit, a launchd label, a pidfile, a log, an ownership record. One
// knob supplies the suffix for all of them, and NOTHING else: ports and state dirs stay explicitly
// configured, because a knob that INVENTS those would be inventing where a second service writes.
//
// Amended 2026-08-12: the config dir is DISCOVERED, not invented. When the process env names an
// instance, `resolveConfigDir` looks for `<conventional>/herdr.collie-<instance>/.env` — a directory
// the operator created — and, finding none, refuses the run instead of resolving anywhere else. It
// never asks herdr (herdr only knows the unsuffixed plugin's dir) and never falls back to the
// unsuffixed or legacy dir. The incident: `COLLIE_INSTANCE=v1 collie pack add` without an injected
// HERDR_PLUGIN_CONFIG_DIR resolved the DEFAULT instance's config and state dirs, so a pack verb read
// the wrong trust store and then minted a fresh self identity into the live stable instance's.

/** The accepted shape of `COLLIE_INSTANCE`: it becomes a unit name, a filename and a launchd label. */
export const INSTANCE_PATTERN = /^[a-z0-9-]{1,16}$/;

/** `""` for the unsuffixed instance, `-v1` for `COLLIE_INSTANCE=v1`. The one place the join is written. */
export const instanceSuffix = (instance: string | null): string => instanceSuffixOf(instance);

/**
 * `COLLIE_INSTANCE` → the suffix, or `null`.
 *
 * **Throws rather than defaulting**, on two conditions, because both would land as a second service
 * quietly colliding with the first:
 *
 *  - a suffix that is not `[a-z0-9-]{1,16}` — it goes into a systemd unit name, a launchd label and a
 *    filename, and none of those forgive a space, a slash or a dot;
 *  - a suffix with **no explicit `COLLIE_PORT`**. The port default (8787) is a property of the host,
 *    not of an instance, so two instances taking it would fight for the same listener and the second
 *    would restart-loop. Naming a second instance is exactly the moment to have decided its port.
 */
export function resolveInstance(env: Environment): string | null {
  const raw = env.COLLIE_INSTANCE?.trim();
  if (raw === undefined || raw === "") return null;
  if (!INSTANCE_PATTERN.test(raw)) {
    throw new Error(
      `COLLIE_INSTANCE="${raw}" is not a usable instance name — 1-16 characters of [a-z0-9-]. ` +
        "It becomes a unit name, a launchd label and a filename.",
    );
  }
  const port = env.COLLIE_PORT?.trim();
  if (port === undefined || !/^\d+$/.test(port)) {
    throw new Error(
      `COLLIE_INSTANCE="${raw}" needs an explicit COLLIE_PORT — the default port belongs to the ` +
        "host's first instance, and two instances sharing it would fight over the listener.",
    );
  }
  return raw;
}

// ── Assembly ─────────────────────────────────────────────────────────────────

/** The home dir, with no environment to read it from: `$HOME`, else the passwd entry. */
export function resolveHome(env: Environment): string {
  const h = env.HOME?.trim();
  if (h) return h;
  try {
    return homedir();
  } catch {
    return "/";
  }
}

/** A variable name shaped like a credential — its value never appears in a diagnostic. */
const SENSITIVE_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PRIVATE)$/;

/** How many per-variable shadow notes {@link shadowNotes} prints before it collapses into a summary. */
const SHADOW_NOTE_CAP = 5;

/**
 * The stderr lines to say when a `.env` value SILENTLY overrides a different value the ambient
 * process environment already carried — `.env` still wins (see {@link loadContext}'s merge
 * comment), this only stops that win from being silent.
 *
 * A name absent from `ambient`, or equal in both, says nothing: nothing was shadowed. A name shaped
 * like a credential ({@link SENSITIVE_ENV_NAME}) is named but never valued, so the note itself never
 * becomes a leak. Past {@link SHADOW_NOTE_CAP} differing names — an `EnvironmentFile=` re-exporting
 * the same `.env`, say — the notes collapse into one summary line rather than flooding stderr.
 */
export function shadowNotes(ambient: Environment, fromFile: EnvVars): string[] {
  const shadowed = Object.keys(fromFile).filter((key) => {
    const before = ambient[key];
    return before !== undefined && before !== fromFile[key];
  });
  const lines = shadowed.slice(0, SHADOW_NOTE_CAP).map((key) => {
    if (SENSITIVE_ENV_NAME.test(key)) {
      return `note: ${key} from your environment is shadowed by .env.`;
    }
    return `note: ${key}=${ambient[key]} from your environment is shadowed by .env (${fromFile[key]}).`;
  });
  const remaining = shadowed.length - lines.length;
  if (remaining > 0) {
    lines.push(`note: ${remaining} more environment variable${remaining === 1 ? "" : "s"} shadowed by .env.`);
  }
  return lines;
}

/**
 * Resolve the context once. `warn` receives diagnostics destined for stderr (the caller owns the
 * stream, so this stays testable).
 */
export function loadContext(warn: (line: string) => void = (l) => console.error(l)): CliContext {
  const root = pluginRoot();
  const home = resolveHome(process.env);
  const { dir: configDir, note } = resolveConfigDir({
    env: process.env,
    home,
    fileExists: existsSync,
    askHerdr: () => askHerdrConfigDir(process.env, home),
  });
  if (note !== null) warn(note);

  // `.env` overrides the ambient environment, exactly as `set -a; . .env` did.
  const env: Environment = { ...process.env };
  const envPath = join(configDir, ".env");
  const dotenv = readIfPresent(envPath);
  if (dotenv !== null) {
    const tightened = tightenEnvFile(envPath, diskEnvPerms);
    if (tightened !== null) warn(tightened);
    const fromFile = parseEnvFile(dotenv);
    for (const line of shadowNotes(process.env, fromFile)) warn(line);
    Object.assign(env, fromFile);
  }

  // Resolved from the MERGED env, so a `.env` may name the instance — the second instance's config
  // dir is its own, and putting `COLLIE_INSTANCE`/`COLLIE_PORT` there is how it stays set for every
  // caller (a Herdr action, a login shell, a systemd unit) rather than only the one that exported it.
  const instance = resolveInstance(env);

  return {
    root,
    instance,
    configDir,
    home,
    env,
    // Suffixed, so a second instance can never tear down the first's `tailscale serve` mapping —
    // even if the operator points both at one config dir (ADR 0001: we touch only what we recorded).
    handlerFile: managedHandlerPath(configDir, instanceSuffix(instance)),
    stateDir: resolveStateDir(env, home),
    ...deriveSettings(env, home),
  };
}

function askHerdrConfigDir(env: Environment, home: string): string | null {
  const herdr = findTool("herdr", env, home);
  if (herdr === null) return null;
  try {
    const r = Bun.spawnSync([herdr, "plugin", "config-dir", PLUGIN_ID], { stderr: "ignore" });
    if (r.exitCode !== 0) return null;
    return r.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

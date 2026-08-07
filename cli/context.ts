import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_PORT, defaultSocketPath, resolveStateDir } from "../bridge/config.ts";
import { pluginRoot } from "../bridge/root.ts";
import { findTool } from "./tools.ts";

export const PLUGIN_ID = "herdr.collie";

/**
 * Everything a verb needs about *where things are*, resolved exactly once and passed down. No verb
 * module reads `process.env` on its own — a single resolution is what keeps the two entry points
 * (Herdr action vs a direct call) from reading different `.env` files, which is the bug
 * `scripts/collie-ctl.sh:17-22` records.
 */
export interface CliContext {
  /** The Collie checkout. */
  root: string;
  /** Where `.env` and the ownership record live. */
  configDir: string;
  /** Resolved home dir — `$HOME` when set, the passwd entry otherwise (there may be no env). */
  home: string;
  /** `.env`-merged environment. The one env any verb should consult. */
  env: Record<string, string | undefined>;
  port: number;
  serveMode: ServeMode;
  socket: string;
  /** The single managed `tailscale serve` mapping's ownership record. */
  handlerFile: string;
  /**
   * Runtime state — the same directory the bridge resolves (`bridge/config.ts`'s `resolveStateDir`),
   * so the pack trust store a verb writes is the one the running service reads.
   */
  stateDir: string;
}

export type ServeMode = "https" | "http";

// ── .env ─────────────────────────────────────────────────────────────────────
// Parsed in process, never `source`d. The shell had to `. "${CONFIG_DIR}/.env"`, which executes it:
// a `bun()` function defined in there would shadow the real binary and poison every later lookup
// (the hazard scripts/collie-ctl.sh:83-97 works around). Parsing removes the hazard outright — a
// `.env` can now only set variables.

/**
 * Parse `KEY=value` lines the way `set -a; . file` would for the assignment-only subset: `export`
 * prefixes, `#` comments, blank lines, and single/double quoted values (double quotes keep the
 * common `\n`/`\t`/`\"`/`\\` escapes; single quotes are literal). Anything that is not an
 * assignment is ignored rather than executed.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
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

// ── Config dir ───────────────────────────────────────────────────────────────

export interface ConfigDirDeps {
  env: Record<string, string | undefined>;
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
 * Injected env → Herdr CLI → Herdr's conventional path (only if it has a `.env`) → `~/.config/collie`.
 * Mirrors `scripts/collie-ctl.sh:23-39` including the legacy-`.env`-ignored note, so config applied
 * one way is never silently dropped the other.
 */
export function resolveConfigDir(deps: ConfigDirDeps): ConfigDirResult {
  const legacy = join(deps.home, ".config", "collie");
  const dir = pick();
  const note =
    dir !== legacy && deps.fileExists(join(legacy, ".env"))
      ? `note: ignoring legacy ${join(legacy, ".env")} — config now lives in ${join(dir, ".env")} (move it there).`
      : null;
  return { dir, note };

  function pick(): string {
    const injected = deps.env.HERDR_PLUGIN_CONFIG_DIR?.trim();
    if (injected) return injected;
    const asked = deps.askHerdr()?.trim();
    if (asked) return asked;
    const conventional = join(deps.home, ".config", "herdr", "plugins", "config", PLUGIN_ID);
    if (deps.fileExists(join(conventional, ".env"))) return conventional;
    return legacy;
  }
}

// ── Version ──────────────────────────────────────────────────────────────────

/**
 * What Collie is actually serving: the built bundle's stamp (`web/dist/build-info.json`, the same id
 * the PWA footer and `/api/config` report), else the manifest version tagged as unbuilt, else
 * `unknown`. Ported from `collie_version()` (`scripts/collie-ctl.sh:191-200`) output for output —
 * this is authoritative in a way Herdr's link-time registry value is not.
 */
export function collieVersionFrom(buildInfo: string | null, manifest: string | null): string {
  if (buildInfo !== null) {
    const stamp = readBuildInfo(buildInfo);
    if (stamp !== null) return stamp;
  }
  const v = manifest === null ? null : /^version[ \t]*=[ \t]*"([^"]*)"/m.exec(manifest)?.[1];
  return v ? `${v} (manifest; web not built)` : "unknown";
}

function readBuildInfo(text: string): string | null {
  let version: string | undefined;
  let sha: string | undefined;
  try {
    const data = JSON.parse(text) as { version?: unknown; sha?: unknown };
    if (typeof data.version === "string") version = data.version;
    if (typeof data.sha === "string") sha = data.sha;
  } catch {
    // The shell read this file with `sed`, so a truncated write still yielded a version. Keep that
    // tolerance rather than falling all the way back to the manifest on a half-written stamp.
    version = /"version"[ \t]*:[ \t]*"([^"]*)"/.exec(text)?.[1];
    sha = /"sha"[ \t]*:[ \t]*"([^"]*)"/.exec(text)?.[1];
  }
  if (!version) return null;
  return sha ? `${version}+${sha}` : version;
}

/** Read the two files {@link collieVersionFrom} judges. Missing/unreadable reads as absent. */
export function collieVersion(root: string, read: (p: string) => string | null = readIfPresent): string {
  return collieVersionFrom(
    read(join(root, "web", "dist", "build-info.json")),
    read(join(root, "herdr-plugin.toml")),
  );
}

function readIfPresent(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

// ── Derived settings ─────────────────────────────────────────────────────────

/**
 * `COLLIE_PORT` → port, `COLLIE_SERVE_MODE` → https|http, `HERDR_SOCKET_PATH` → socket.
 *
 * The port and socket defaults come from `bridge/config.ts`, not from a second copy: the CLI writes
 * them into the generated unit and the bridge reads them at boot, so a divergence would put the
 * service on one port and the banner on another.
 */
export function deriveSettings(
  env: Record<string, string | undefined>,
  home: string,
): Pick<CliContext, "port" | "serveMode" | "socket"> {
  const rawPort = env.COLLIE_PORT?.trim();
  const port = rawPort && /^\d+$/.test(rawPort) ? Number(rawPort) : DEFAULT_PORT;
  const mode = env.COLLIE_SERVE_MODE?.trim();
  return {
    port,
    serveMode: mode === "http" ? "http" : "https",
    socket: env.HERDR_SOCKET_PATH?.trim() || defaultSocketPath(process.platform, env, home),
  };
}

// ── Assembly ─────────────────────────────────────────────────────────────────

/** The home dir, with no environment to read it from: `$HOME`, else the passwd entry. */
export function resolveHome(env: Record<string, string | undefined>): string {
  const h = env.HOME?.trim();
  if (h) return h;
  try {
    return homedir();
  } catch {
    return "/";
  }
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
  const env: Record<string, string | undefined> = { ...process.env };
  const dotenv = readIfPresent(join(configDir, ".env"));
  if (dotenv !== null) Object.assign(env, parseEnvFile(dotenv));

  return {
    root,
    configDir,
    home,
    env,
    handlerFile: join(configDir, "tailscale-managed-handler"),
    stateDir: resolveStateDir(env, home),
    ...deriveSettings(env, home),
  };
}

function askHerdrConfigDir(env: Record<string, string | undefined>, home: string): string | null {
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

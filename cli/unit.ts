import { join } from "node:path";

import type { CliContext } from "./context.ts";
import { PLUGIN_ID } from "./context.ts";

// The service definition, as a pure function of where things are. The shell wrote these with a
// heredoc straight into `~/.config/systemd/user` and `~/Library/LaunchAgents`, so the only way to
// see the text was to install it; here the generators are total functions and their full output is
// pinned in `cli/unit.test.ts`.
//
// systemd unit ↔ launchd agent, kept parallel so both describe ONE service:
//   WantedBy=default.target -> RunAtLoad          Restart=on-failure -> KeepAlive/SuccessfulExit
//   RestartSec=5            -> ThrottleInterval   WorkingDirectory   -> WorkingDirectory
// No analogue on launchd: StartLimitIntervalSec (it has no start limit), NoNewPrivileges,
// PrivateTmp — the agent is simply less confined. No ProcessType either: Background throttles CPU
// and I/O, and the bridge answers a phone.

/** The systemd `--user` unit name, and the launchd label (the plugin id, so `launchctl print` names the job as `herdr plugin list` names the plugin). */
export const UNIT_NAME = "collie";
export const AGENT_LABEL = PLUGIN_ID;

export interface ServiceSpec {
  /** The Collie checkout. */
  root: string;
  /** The supervised program: `<root>/bin/collie`. */
  binary: string;
  configDir: string;
  socket: string;
  port: number;
}

/** Where the compiled binary lives relative to its checkout — the one place that layout is written down. */
export function collieBinary(root: string): string {
  return join(root, "bin", "collie");
}

export function serviceSpec(ctx: CliContext): ServiceSpec {
  return {
    root: ctx.root,
    binary: collieBinary(ctx.root),
    configDir: ctx.configDir,
    socket: ctx.socket,
    port: ctx.port,
  };
}

export function unitFilePath(home: string): string {
  return join(home, ".config", "systemd", "user", `${UNIT_NAME}.service`);
}

export function agentFilePath(home: string): string {
  return join(home, "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);
}

/**
 * The argv the supervisor runs, and the same argv the unsupervised fallback spawns. One definition,
 * because `stopPidfileProcess` recognises its own bridge by this command line — a second copy would
 * drift and the liveness guard would silently degrade to killing nothing.
 */
export function bridgeCommand(spec: ServiceSpec): string[] {
  return [spec.binary, "_exec-bridge"];
}

/**
 * The environment the bridge is launched with. PATHS ONLY, never config values: the plist has to be
 * world-readable (launchd refuses a world-writable one) while `.env` is mode 600 and may hold
 * `COLLIE_VAPID_PRIVATE` — so `_exec-bridge` parses `.env` itself at launch rather than anything
 * baking a Web Push signing key into a readable file.
 *
 * `HERDR_PLUGIN_CONFIG_DIR` is passed because config-dir resolution must not shell out to `herdr`
 * at login, before the server is up. `COLLIE_PLUGIN_ROOT` is passed because the compiled binary
 * cannot derive the checkout from its own module path (bridge/root.ts) and `web/dist` is served
 * from disk.
 */
export function bridgeEnvironment(spec: ServiceSpec): Record<string, string> {
  return {
    HERDR_SOCKET_PATH: spec.socket,
    COLLIE_PORT: String(spec.port),
    HERDR_PLUGIN_CONFIG_DIR: spec.configDir,
    COLLIE_PLUGIN_ROOT: spec.root,
  };
}

export function systemdUnit(spec: ServiceSpec): string {
  const env = bridgeEnvironment(spec);
  return `[Unit]
Description=Collie
After=default.target
# Never give up restarting — a phone-only operator can't run 'systemctl reset-failed'.
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${spec.root}
ExecStart=${bridgeCommand(spec).join(" ")}
Restart=on-failure
RestartSec=5
# Hardening: the bridge is remote shell access, so deny privilege escalation and give it a private
# /tmp. ProtectSystem is intentionally NOT set — the only write path is the env-driven state dir,
# which Herdr may inject to an arbitrary location, so it can't be enumerated in a static ReadWritePaths.
NoNewPrivileges=yes
PrivateTmp=yes
${Object.entries(env)
  .map(([k, v]) => `Environment=${k}=${v}`)
  .join("\n")}
# Leading '-': a missing .env is not a startup failure.
EnvironmentFile=-${join(spec.configDir, ".env")}

[Install]
WantedBy=default.target
`;
}

/**
 * Escape a value for XML character data — a checkout path containing `&` or `<` would otherwise
 * emit a plist launchd can't parse. `&` first, or it re-escapes the ampersands the later rules
 * introduce.
 */
export function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The plist's file mode. launchd refuses to bootstrap a world-writable plist, whatever the umask left behind. */
export const AGENT_FILE_MODE = 0o644;

export function launchAgentPlist(spec: ServiceSpec): string {
  const env = bridgeEnvironment(spec);
  const args = bridgeCommand(spec)
    .map((a) => `        <string>${xmlEscape(a)}</string>`)
    .join("\n");
  const envEntries = Object.entries(env)
    .map(([k, v]) => `        <key>${xmlEscape(k)}</key>\n        <string>${xmlEscape(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEscape(AGENT_LABEL)}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(spec.root)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>${xmlEscape(join(spec.configDir, "collie.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(join(spec.configDir, "collie.log"))}</string>
</dict>
</plist>
`;
}

/**
 * The `KEY=` directives a systemd unit declares, in order, ignoring values and comments. Used to
 * hold `systemd/collie.service` — the hand-managed reference copy an operator may install directly
 * — to the same shape as the generated one, so the two can't drift.
 */
export function unitDirectives(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      out.push(line);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    // Environment= repeats with a different variable each time, so the variable name is part of
    // the directive's identity.
    out.push(key === "Environment" ? `Environment=${line.slice(eq + 1).split("=")[0]}` : key);
  }
  return out;
}

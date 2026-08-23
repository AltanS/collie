import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Ctx, ShellCommand } from "../types.ts";
import {
  asInstalledBackend,
  bunBinary,
  checkedShell,
  checkoutRoot,
  tailCommand,
  type BackendFactoryOptions,
  type InstalledServiceBackend,
} from "./common.ts";

export const SYSTEMD_UNIT_NAME = "collie";
export const SYSTEMD_UNIT = SYSTEMD_UNIT_NAME;

export interface SystemdBackendOptions extends BackendFactoryOptions {
  /** Home directory used for the per-user unit, injectable for fixture tests. */
  homeDir?: string;
  /** Unit name, kept configurable for isolated integration fixtures. */
  unitName?: string;
}

function resolvedOptions(options: SystemdBackendOptions): Required<Pick<SystemdBackendOptions, "rootDir" | "bun" | "homeDir" | "unitName">> {
  return {
    rootDir: checkoutRoot(options.rootDir),
    bun: bunBinary(options.bun),
    homeDir: options.homeDir ?? homedir(),
    unitName: options.unitName ?? SYSTEMD_UNIT_NAME,
  };
}

export function systemdUnitFile(options: SystemdBackendOptions = {}): string {
  const resolved = resolvedOptions(options);
  return join(resolved.homeDir, ".config", "systemd", "user", `${resolved.unitName}.service`);
}

function systemdLiteral(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")}"`;
}

function systemdEnvironment(name: string, value: string): string {
  return `Environment=${systemdLiteral(`${name}=${value}`)}`;
}

/** Render the generated systemd --user unit, preserving collie-ctl.sh's service policy. */
export function renderSystemdUnit(ctx: Ctx, options: SystemdBackendOptions = {}): string {
  const resolved = resolvedOptions(options);
  const rootDir = ctx.rootDir ?? resolved.rootDir;
  return `[Unit]
Description=Collie
After=default.target
# Never give up restarting - a phone-only operator cannot run systemctl reset-failed.
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${systemdLiteral(rootDir)}
ExecStart=${systemdLiteral(resolved.bun)} scripts/ctl/main.ts exec-bridge
Restart=on-failure
RestartSec=5
# Keep the remote shell bridge unprivileged and isolate its temporary files.
NoNewPrivileges=yes
PrivateTmp=yes
${systemdEnvironment("HERDR_SOCKET_PATH", ctx.socketPath)}
Environment=COLLIE_PORT=8787
${systemdEnvironment("HERDR_PLUGIN_CONFIG_DIR", ctx.configDir)}
${systemdEnvironment("HERDR_PLUGIN_STATE_DIR", ctx.stateDir)}
EnvironmentFile=-${systemdLiteral(join(ctx.configDir, ".env"))}

[Install]
WantedBy=default.target
`;
}

export function createSystemdBackend(options: SystemdBackendOptions = {}): InstalledServiceBackend {
  const resolved = resolvedOptions(options);
  const unitFile = systemdUnitFile(options);
  const unitName = resolved.unitName;

  return asInstalledBackend({
    async install(ctx: Ctx): Promise<void> {
      await mkdir(dirname(unitFile), { recursive: true });
      await writeFile(unitFile, renderSystemdUnit(ctx, options), "utf8");
      await checkedShell(ctx, "systemctl", ["--user", "daemon-reload"]);
    },

    async start(ctx: Ctx): Promise<void> {
      await checkedShell(ctx, "systemctl", ["--user", "enable", "--now", unitName]);
    },

    async stop(ctx: Ctx): Promise<void> {
      await checkedShell(ctx, "systemctl", ["--user", "disable", "--now", unitName]);
    },

    async uninstall(ctx: Ctx): Promise<void> {
      await rm(unitFile, { force: true });
      await checkedShell(ctx, "systemctl", ["--user", "daemon-reload"]);
      await checkedShell(ctx, "systemctl", ["--user", "reset-failed", unitName]);
    },

    async isActive(ctx: Ctx): Promise<boolean> {
      try {
        const result = await ctx.shell("systemctl", ["--user", "is-active", unitName]);
        return result.exitCode === 0 && result.stdout.trim() === "active";
      } catch {
        return false;
      }
    },

    logsCmd(ctx: Ctx, lines?: number): ShellCommand {
      return tailCommand(join(ctx.stateDir, "collie.log"), lines);
    },
  });
}

export const systemdBackend = createSystemdBackend();
export const backend = systemdBackend;
export default systemdBackend;

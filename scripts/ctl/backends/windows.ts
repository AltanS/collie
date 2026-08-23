import { join } from "node:path";

import type { Ctx, ShellCommand } from "../types.ts";
import {
  asInstalledBackend,
  bunBinary,
  checkedShell,
  checkoutRoot,
  logLineCount,
  powershellLiteral,
  type BackendFactoryOptions,
  type InstalledServiceBackend,
} from "./common.ts";

export const WINDOWS_TASK_NAME = "CollieBridge";
export const TASK_NAME = WINDOWS_TASK_NAME;

export interface WindowsBackendOptions extends BackendFactoryOptions {
  /** Task name, injectable for isolated fixtures while keeping the shipped name stable. */
  taskName?: string;
  /** PowerShell executable used to invoke the built-in Scheduled Tasks cmdlets. */
  powershell?: string;
  /** Built-in task query executable. */
  schtasks?: string;
  /** Built-in process termination executable. */
  taskkill?: string;
}

interface ResolvedWindowsOptions {
  rootDir: string;
  bun: string;
  taskName: string;
  powershell: string;
  schtasks: string;
  taskkill: string;
}

function resolvedOptions(options: WindowsBackendOptions): ResolvedWindowsOptions {
  return {
    rootDir: checkoutRoot(options.rootDir),
    bun: bunBinary(options.bun),
    taskName: options.taskName ?? WINDOWS_TASK_NAME,
    powershell: options.powershell ?? "powershell.exe",
    schtasks: options.schtasks ?? "schtasks",
    taskkill: options.taskkill ?? "taskkill",
  };
}

function powershellArgs(script: string): readonly string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ];
}

/**
 * The action that Task Scheduler launches at logon. The environment is explicit because a task
 * does not inherit the shell that invoked `ctl`. NO file redirection happens here: exec-bridge
 * owns `collie.log` (single writer — a wrapper redirect would hold the handle open and make the
 * bridge's own Bun.file(logFile) open fail with EBUSY on Windows).
 */
function taskActionArguments(ctx: Ctx, options: ResolvedWindowsOptions): string {
  const action = [
    `New-Item -ItemType Directory -Force -Path ${powershellLiteral(ctx.stateDir)} | Out-Null`,
    `$env:HERDR_PLUGIN_CONFIG_DIR = ${powershellLiteral(ctx.configDir)}`,
    `$env:HERDR_PLUGIN_STATE_DIR = ${powershellLiteral(ctx.stateDir)}`,
    `$env:HERDR_SOCKET_PATH = ${powershellLiteral(ctx.socketPath)}`,
    `& ${powershellLiteral(options.bun)} ${powershellLiteral("scripts/ctl/main.ts")} ${powershellLiteral("exec-bridge")}`,
  ].join("; ");
  return `-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& { ${action} }"`;
}

/** Render the PowerShell registration script used by install. */
export function renderTaskRegistration(ctx: Ctx, options: WindowsBackendOptions = {}): string {
  const resolved = resolvedOptions(options);
  const rootDir = ctx.rootDir ?? resolved.rootDir;
  const actionArguments = taskActionArguments(ctx, resolved);
  return [
    `$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name`,
    `$action = New-ScheduledTaskAction -Execute ${powershellLiteral("powershell.exe")} -Argument ${powershellLiteral(actionArguments)} -WorkingDirectory ${powershellLiteral(rootDir)}`,
    `$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity`,
    `$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited`,
    `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable`,
    `Register-ScheduledTask -TaskName ${powershellLiteral(resolved.taskName)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description ${powershellLiteral("Collie mobile bridge for Herdr")} -Force | Out-Null`,
  ].join("; ");
}

/** Render the bounded process query used by Windows stop's force-kill fallback. */
export function renderBridgePidQuery(rootDir: string): string {
  return [
    `$root = ${powershellLiteral(rootDir)}`,
    `Get-CimInstance Win32_Process -Filter ${powershellLiteral("Name = 'bun.exe'")} | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('exec-bridge') -and ($_.CommandLine.Contains($root) -or $_.CommandLine.Contains('scripts/ctl/main.ts')) } | Select-Object -ExpandProperty ProcessId`,
  ].join("; ");
}

/** Parse the PID-only output from renderBridgePidQuery. */
export function parseBridgePids(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line));
}

/** Parse schtasks' localized list output without treating Ready as running. */
export function parseScheduledTaskActive(stdout: string): boolean {
  return stdout.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return /^(?:status|state)\s*:\s*running$/i.test(trimmed) || /^running$/i.test(trimmed);
  });
}

export function createWindowsBackend(options: WindowsBackendOptions = {}): InstalledServiceBackend {
  const resolved = resolvedOptions(options);

  return asInstalledBackend({
    async install(ctx: Ctx): Promise<void> {
      await checkedShell(
        ctx,
        resolved.powershell,
        powershellArgs(renderTaskRegistration(ctx, options)),
      );
    },

    async start(ctx: Ctx): Promise<void> {
      await checkedShell(
        ctx,
        resolved.powershell,
        powershellArgs(
          `Start-ScheduledTask -TaskName ${powershellLiteral(resolved.taskName)}`,
        ),
      );
    },

    async stop(ctx: Ctx): Promise<void> {
      await checkedShell(
        ctx,
        resolved.powershell,
        powershellArgs(
          `Stop-ScheduledTask -TaskName ${powershellLiteral(resolved.taskName)} -ErrorAction SilentlyContinue`,
        ),
      );

      const pidResult = await checkedShell(
        ctx,
        resolved.powershell,
        powershellArgs(renderBridgePidQuery(ctx.rootDir ?? resolved.rootDir)),
      );
      for (const pid of parseBridgePids(pidResult.stdout)) {
        await checkedShell(ctx, resolved.taskkill, ["/PID", pid, "/T", "/F"]);
      }
    },

    async uninstall(ctx: Ctx): Promise<void> {
      await checkedShell(
        ctx,
        resolved.powershell,
        powershellArgs(
          `Unregister-ScheduledTask -TaskName ${powershellLiteral(resolved.taskName)} -Confirm:$false -ErrorAction SilentlyContinue`,
        ),
      );
    },

    async isActive(ctx: Ctx): Promise<boolean> {
      try {
        const result = await ctx.shell(resolved.schtasks, [
          "/query",
          "/tn",
          resolved.taskName,
          "/fo",
          "LIST",
        ]);
        return result.exitCode === 0 && parseScheduledTaskActive(result.stdout);
      } catch {
        return false;
      }
    },

    logsCmd(ctx: Ctx, lines?: number): ShellCommand {
      const count = logLineCount(lines);
      const file = join(ctx.stateDir, "collie.log");
      return {
        command: resolved.powershell,
        args: powershellArgs(
          `if (Test-Path -LiteralPath ${powershellLiteral(file)}) { Get-Content -LiteralPath ${powershellLiteral(file)} -Tail ${count} } else { '(no log)' }`,
        ),
      };
    },
  });
}

export const windowsBackend = createWindowsBackend();
export const backend = windowsBackend;
export default windowsBackend;

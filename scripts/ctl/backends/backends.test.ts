import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { Ctx, ShellResult } from "../types.ts";
import {
  createWindowsBackend,
  parseBridgePids,
  parseScheduledTaskActive,
  renderBridgePidQuery,
  renderTaskRegistration,
} from "./windows.ts";
import {
  createSystemdBackend,
  renderSystemdUnit,
  systemdUnitFile,
} from "./systemd.ts";
import {
  createLaunchdBackend,
  launchdAgentFile,
  launchdTarget,
  renderLaunchdPlist,
} from "./launchd.ts";

type Call = { command: string; args: readonly string[] };

function result(stdout = "", stderr = "", exitCode = 0): ShellResult {
  return { stdout, stderr, exitCode };
}

function context(
  responses: ShellResult[] = [],
): { ctx: Ctx; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    ctx: {
      configDir: "C:\\Users\\collie\\config",
      stateDir: "C:\\Users\\collie\\state",
      socketPath: "C:\\Users\\collie\\herdr.sock",
      log() {},
      shell: async (command, args = []) => {
        calls.push({ command, args });
        return responses.shift() ?? result();
      },
    },
  };
}

async function temporaryHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "collie-backend-"));
}

async function remove(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

describe("Windows Task Scheduler backend", () => {
  test("pins registration, per-user start, and logon action details", async () => {
    const { ctx, calls } = context();
    const backend = createWindowsBackend({ rootDir: "C:\\checkout", bun: "bun" });

    await backend.install(ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        renderTaskRegistration(ctx, { rootDir: "C:\\checkout", bun: "bun" }),
      ],
    });
    expect(calls[0]?.args.at(-1)).toContain("New-ScheduledTaskTrigger -AtLogOn -User $identity");
    expect(calls[0]?.args.at(-1)).toContain("-WorkingDirectory 'C:\\checkout'");
    expect(calls[0]?.args.at(-1)).toContain("scripts/ctl/main.ts");
    expect(calls[0]?.args.at(-1)).toContain("exec-bridge");
    expect(calls[0]?.args.at(-1)).toContain("RestartCount 999");
    expect(calls[0]?.args.at(-1)).toContain("RestartInterval (New-TimeSpan -Minutes 1)");
    // Single writer: exec-bridge owns collie.log, so the wrapper must NOT redirect into it
    // (double-open fails with EBUSY on Windows).
    expect(calls[0]?.args.at(-1)).not.toContain("collie.log");

    await backend.start(ctx);
    expect(calls[1]).toEqual({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Start-ScheduledTask -TaskName 'CollieBridge'",
      ],
    });
  });

  test("stops the task and force-kills a surviving bridge PID", async () => {
    const { ctx, calls } = context([result(), result("421\r\n"), result()]);
    const backend = createWindowsBackend({ rootDir: "C:\\checkout" });

    await backend.stop(ctx);

    expect(calls).toEqual([
      {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "Stop-ScheduledTask -TaskName 'CollieBridge' -ErrorAction SilentlyContinue",
        ],
      },
      {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          renderBridgePidQuery("C:\\checkout"),
        ],
      },
      { command: "taskkill", args: ["/PID", "421", "/T", "/F"] },
    ]);
  });

  test("uninstalls through the built-in cmdlet and propagates registration failures", async () => {
    const { ctx, calls } = context();
    const backend = createWindowsBackend();

    await backend.uninstall(ctx);
    expect(calls[0]).toEqual({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Unregister-ScheduledTask -TaskName 'CollieBridge' -Confirm:$false -ErrorAction SilentlyContinue",
      ],
    });

    const failed = context([result("", "registration failed", 23)]);
    await expect(createWindowsBackend().install(failed.ctx)).rejects.toThrow("registration failed");
    expect(failed.calls).toHaveLength(1);
  });

  test("parses running state and only numeric process ids", () => {
    expect(parseScheduledTaskActive("TaskName: \\CollieBridge\r\nStatus: Running\r\n")).toBe(true);
    expect(parseScheduledTaskActive("TaskName: \\CollieBridge\r\nStatus: Ready\r\n")).toBe(false);
    expect(parseBridgePids("421\r\nnot-a-pid\r\n  900  \n")).toEqual(["421", "900"]);
    expect(renderBridgePidQuery("C:\\checkout")).toContain("Get-CimInstance Win32_Process");
  });
});

describe("systemd --user backend", () => {
  test("writes the unit and preserves enable, stop, reset, and file logs", async () => {
    const home = await temporaryHome();
    try {
      const { ctx, calls } = context();
      const options = { homeDir: home, rootDir: "/checkout", bun: "bun" };
      const backend = createSystemdBackend(options);

      await backend.install(ctx);
      expect(await readFile(systemdUnitFile(options), "utf8")).toBe(renderSystemdUnit(ctx, options));
      expect(calls).toEqual([
        { command: "systemctl", args: ["--user", "daemon-reload"] },
      ]);

      await backend.start(ctx);
      await backend.stop(ctx);
      expect(backend.logsCmd(ctx, 9)).toEqual({
        command: "tail",
        args: ["-n", "9", join(ctx.stateDir, "collie.log")],
      });
      await backend.uninstall(ctx);
      expect(calls).toEqual([
        { command: "systemctl", args: ["--user", "daemon-reload"] },
        { command: "systemctl", args: ["--user", "enable", "--now", "collie"] },
        { command: "systemctl", args: ["--user", "disable", "--now", "collie"] },
        { command: "systemctl", args: ["--user", "daemon-reload"] },
        { command: "systemctl", args: ["--user", "reset-failed", "collie"] },
      ]);
      await expect(stat(systemdUnitFile(options))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await remove(home);
    }
  });
});

describe("launchd backend", () => {
  test("writes the per-user plist and uses bootstrap, disable, and bootout", async () => {
    const home = await temporaryHome();
    try {
      const { ctx, calls } = context();
      const options = { homeDir: home, uid: 42, rootDir: "/checkout", bun: "bun" };
      const backend = createLaunchdBackend(options);

      await backend.install(ctx);
      expect(await readFile(launchdAgentFile(options), "utf8")).toBe(renderLaunchdPlist(ctx, options));
      expect(await readFile(launchdAgentFile(options), "utf8")).toContain(
        "<string>scripts/ctl/main.ts</string>",
      );
      await backend.start(ctx);
      await backend.stop(ctx);
      await backend.uninstall(ctx);

      expect(calls).toEqual([
        { command: "launchctl", args: ["bootout", launchdTarget(options)] },
        { command: "launchctl", args: ["enable", launchdTarget(options)] },
        { command: "launchctl", args: ["bootstrap", "gui/42", launchdAgentFile(options)] },
        { command: "launchctl", args: ["disable", launchdTarget(options)] },
        { command: "launchctl", args: ["bootout", launchdTarget(options)] },
        { command: "launchctl", args: ["enable", launchdTarget(options)] },
      ]);
      await expect(stat(launchdAgentFile(options))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await remove(home);
    }
  });

  test("reports active only when launchctl print exposes a running process", async () => {
    const active = context([result("pid = 1234\n")]);
    expect(await createLaunchdBackend({ uid: 9 }).isActive(active.ctx)).toBe(true);
    const loaded = context([result("state = loaded\n")]);
    expect(await createLaunchdBackend({ uid: 9 }).isActive(loaded.ctx)).toBe(false);
    const missing = context([result("", "not found",  exitCodeForMissingTask())]);
    expect(await createLaunchdBackend({ uid: 9 }).isActive(missing.ctx)).toBe(false);
  });
});

function exitCodeForMissingTask(): number {
  return 113;
}

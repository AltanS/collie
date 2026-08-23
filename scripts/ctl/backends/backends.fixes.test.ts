import { describe, expect, test } from "bun:test";

import type { Ctx, ShellResult } from "../types.ts";
import { bunBinary } from "./common.ts";
import { createLaunchdBackend } from "./launchd.ts";
import { renderSystemdUnit } from "./systemd.ts";
import { renderBridgePidQuery } from "./windows.ts";

type Call = { command: string; args: readonly string[] };

function result(stdout = "", stderr = "", exitCode = 0): ShellResult {
  return { stdout, stderr, exitCode };
}

function context(responses: readonly ShellResult[] = []): { ctx: Ctx; calls: Call[] } {
  const pending = [...responses];
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
        return pending.shift() ?? result();
      },
    },
  };
}

describe("backend regression fixes", () => {
  test("defaults to the current absolute Bun executable", () => {
    // Given: no environment override.
    const previous = process.env.BUN_BINARY;
    try {
      delete process.env.BUN_BINARY;

      // When: the backend resolves its Bun executable.
      const resolved = bunBinary(undefined);

      // Then: it uses the current Bun process.
      expect(resolved).toBe(process.execPath);
    } finally {
      if (previous === undefined) delete process.env.BUN_BINARY;
      else process.env.BUN_BINARY = previous;
    }
  });

  test("honors the BUN_BINARY environment override", () => {
    // Given: an environment override.
    const previous = process.env.BUN_BINARY;
    try {
      process.env.BUN_BINARY = "env-bun";

      // When: no explicit backend executable is supplied.
      const resolved = bunBinary(undefined);

      // Then: the environment executable wins over the process default.
      expect(resolved).toBe("env-bun");
    } finally {
      if (previous === undefined) delete process.env.BUN_BINARY;
      else process.env.BUN_BINARY = previous;
    }
  });

  test("honors an explicit Bun executable over the environment", () => {
    // Given: both environment and explicit executable values.
    const previous = process.env.BUN_BINARY;
    try {
      process.env.BUN_BINARY = "env-bun";

      // When: an explicit backend executable is supplied.
      const resolved = bunBinary("explicit-bun");

      // Then: the explicit value wins.
      expect(resolved).toBe("explicit-bun");
    } finally {
      if (previous === undefined) delete process.env.BUN_BINARY;
      else process.env.BUN_BINARY = previous;
    }
  });

  test("quotes systemd paths and environment values without changing their contents", () => {
    // Given: service paths containing spaces, backslashes, and double quotes.
    const rootDir = String.raw`C:\checkout path\with "quotes"`;
    const bun = String.raw`C:\Program Files\Bun "runtime"\bun.exe`;
    const configDir = String.raw`C:\config path\value "quoted"`;
    const stateDir = String.raw`C:\state path\value "quoted"`;
    const socketPath = String.raw`C:\socket path\value "quoted"`;
    const { ctx } = context();
    const specialContext: Ctx = { ...ctx, configDir, stateDir, socketPath, rootDir };

    // When: the systemd unit is rendered.
    const unit = renderSystemdUnit(specialContext, { rootDir, bun });

    // Then: every systemd value is quoted and every embedded slash/quote is escaped.
    expect(unit).toContain(String.raw`WorkingDirectory="C:\\checkout path\\with \"quotes\""`);
    expect(unit).toContain(
      String.raw`ExecStart="C:\\Program Files\\Bun \"runtime\"\\bun.exe" scripts/ctl/main.ts exec-bridge`,
    );
    expect(unit).toContain(
      String.raw`Environment="HERDR_SOCKET_PATH=C:\\socket path\\value \"quoted\""`,
    );
    expect(unit).toContain(
      String.raw`Environment="HERDR_PLUGIN_CONFIG_DIR=C:\\config path\\value \"quoted\""`,
    );
    expect(unit).toContain(
      String.raw`Environment="HERDR_PLUGIN_STATE_DIR=C:\\state path\\value \"quoted\""`,
    );
    expect(unit).toContain(
      String.raw`EnvironmentFile=-"C:\\config path\\value \"quoted\"\\.env"`,
    );
  });

  test("retries transient launchd bootstrap failures three times", async () => {
    // Given: cleanup succeeds, then bootstrap fails twice before succeeding.
    const { ctx, calls } = context([
      result(),
      result(),
      result("", "bootstrap race 1", 5),
      result("", "bootstrap race 2", 5),
      result(),
    ]);
    const waits: number[] = [];
    const backend = createLaunchdBackend({
      uid: 42,
      rootDir: "C:\\checkout",
      bun: "bun",
      retryWait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    // When: launchd start performs bootstrap.
    await backend.start(ctx);

    // Then: only the bounded retry waits occur before the successful third attempt.
    expect(waits).toEqual([1000, 1000]);
    expect(calls.filter((call) => call.args[0] === "bootstrap")).toHaveLength(3);
  });

  test("propagates the final launchd bootstrap error after three failures", async () => {
    // Given: every bootstrap attempt fails and the retry waiter is immediate.
    const finalFailure = "bootstrap failed for the third time";
    const { ctx, calls } = context([
      result(),
      result(),
      result("", "bootstrap failed first", 5),
      result("", "bootstrap failed second", 5),
      result("", finalFailure, 5),
    ]);
    const waits: number[] = [];
    const backend = createLaunchdBackend({
      uid: 42,
      retryWait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    // When/Then: the final bootstrap diagnostic is not swallowed.
    await expect(backend.start(ctx)).rejects.toThrow(finalFailure);
    expect(waits).toEqual([1000, 1000]);
    expect(calls.filter((call) => call.args[0] === "bootstrap")).toHaveLength(3);
  });

  test("does not retry unexpected launchd bootstrap errors", async () => {
    // Given: launchd cannot be spawned at all, which is not a retryable exit status.
    const unexpected = new Error("launchctl could not be spawned");
    const { ctx, calls } = context([result(), result()]);
    const waits: number[] = [];
    const shell = ctx.shell;
    ctx.shell = async (command, args = []) => {
      if (args[0] === "bootstrap") {
        calls.push({ command, args });
        throw unexpected;
      }
      return await shell(command, args);
    };
    const backend = createLaunchdBackend({
      uid: 42,
      retryWait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    // When/Then: the unexpected error propagates immediately.
    await expect(backend.start(ctx)).rejects.toBe(unexpected);
    expect(waits).toEqual([]);
    expect(calls.filter((call) => call.args[0] === "bootstrap")).toHaveLength(1);
  });

  test("limits Windows force-kill discovery to the absolute bridge entrypoint", () => {
    // Given: a checkout root whose bridge entrypoint is the only owned process target.
    const query = renderBridgePidQuery("C:\\checkout");

    // When/Then: the query names bridge/index.ts and has no broad ctl-main fallback.
    expect(query).toContain("$bridge = 'C:\\checkout\\bridge\\index.ts'");
    expect(query).toContain("-match $bridgePattern");
    expect(query).not.toContain("scripts/ctl/main.ts");
    expect(query).not.toContain("exec-bridge");
    expect(query).not.toContain("-or");
  });
});

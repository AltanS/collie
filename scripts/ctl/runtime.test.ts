import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { InstalledServiceBackend } from "./backends/common.ts";
import {
  backendForName,
  createHandlers,
  defaultRuntimeDependencies,
  type RuntimeDependencies,
} from "./runtime.ts";
import type { Ctx, ShellCommand, ShellResult } from "./types.ts";

type Fixture = {
  readonly root: string;
  readonly calls: string[];
  readonly output: string[];
  readonly ctx: Ctx;
};

async function fixture(name: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `collie-runtime-${name}-`));
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const calls: string[] = [];
  const output: string[] = [];
  return {
    root,
    calls,
    output,
    ctx: {
      rootDir: root,
      configDir,
      stateDir,
      socketPath: join(root, "herdr.sock"),
      log: (...args) => output.push(args.map(String).join(" ")),
      shell: async (command, args = []): Promise<ShellResult> => {
        calls.push([command, ...args].join(" "));
        return { stdout: "actual log line\n", stderr: "", exitCode: 0 };
      },
    },
  };
}

function backend(calls: string[]): InstalledServiceBackend {
  return {
    async install() {
      calls.push("install");
    },
    async start() {
      calls.push("backend-start");
    },
    async stop() {
      calls.push("backend-stop");
    },
    async uninstall() {
      calls.push("backend-uninstall");
    },
    async isActive() {
      return true;
    },
    logsCmd(): ShellCommand {
      return { command: "log-reader", args: ["--lines", "7"] };
    },
  };
}

function dependencies(value: Fixture): RuntimeDependencies {
  return {
    ...defaultRuntimeDependencies,
    backend: () => backend(value.calls),
    backendKind: () => "systemd",
    waitForReadiness: async () => true,
    ops: {
      ...defaultRuntimeDependencies.ops,
      build: async () => {
        value.calls.push("build");
      },
      serve: async () => {
        value.calls.push("serve");
      },
      unserve: async () => {
        value.calls.push("unserve");
      },
    },
  };
}

async function withFixture(
  name: string,
  run: (value: Fixture) => Promise<void>,
): Promise<void> {
  const value = await fixture(name);
  try {
    await run(value);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
}

describe("real ctl runtime wiring", () => {
  test("uses the unsupervised backend when no user supervisor is available", async () => {
    await withFixture("fallback", async (value) => {
      const fallback = backendForName(undefined);

      expect(fallback.logsCmd(value.ctx, 3).command).toBe("tail");
    });
  });

  test("start publishes the managed front door after readiness", async () => {
    await withFixture("start", async (value) => {
      await createHandlers(dependencies(value)).start(value.ctx, []);

      expect(value.calls).toEqual(["build", "install", "backend-start", "serve"]);
    });
  });

  test("uninstall removes the managed front door before registration", async () => {
    await withFixture("uninstall", async (value) => {
      await createHandlers(dependencies(value)).uninstall(value.ctx, []);

      expect(value.calls).toEqual([
        "backend-stop",
        "unserve",
        "backend-uninstall",
      ]);
    });
  });

  test("logs executes the backend reader and prints its output", async () => {
    await withFixture("logs", async (value) => {
      await createHandlers(dependencies(value)).logs(value.ctx, ["7"]);

      expect(value.calls).toContain("log-reader --lines 7");
      expect(value.output).toEqual(["actual log line\n"]);
    });
  });

  test("url uses the configured Variant E public URL", async () => {
    await withFixture("url", async (value) => {
      const ctx: Ctx = {
        ...value.ctx,
        env: { COLLIE_PUBLIC_URL: "https://collie.example" },
      };

      await createHandlers(dependencies(value)).url(ctx, []);

      expect(value.output).toEqual(["https://collie.example"]);
    });
  });
});

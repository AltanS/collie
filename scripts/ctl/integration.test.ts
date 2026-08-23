/**
 * Hermetic ctl integration coverage migrated from scripts/collie-ctl.test.sh:
 * - lines 1-80: temporary HOME/config/state isolation and fake subprocess boundaries;
 * - lines 345-361: test_serve_failure_does_not_abort_start (serve failure is isolated from the
 *   independently successful start route);
 * - lines 373-473: test_launchd_agent_lifecycle (idempotent bootstrap/teardown and secret-free plist);
 * - lines 478-505: test_launchd_status_line (running launchd PID is used by the status route).
 *
 * Every command, service backend, readiness probe, Git operation, Tailscale operation, and bridge
 * spawn below is injected. No test reaches systemctl, launchctl, schtasks, taskkill, tailscale, git,
 * or a network endpoint.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { ALL_VERBS, dispatch, USAGE } from "./main.ts";
import type { Ctx } from "./types.ts";
import {
  logs as infoLogs,
  qr as infoQr,
  status as infoStatus,
  url as infoUrl,
  version as infoVersion,
  type InfoDeps,
} from "./verbs-info.ts";
import {
  build,
  execBridge,
  pushKeys,
  pushTest,
  serve,
  unserve,
  type BuildOptions,
  type CommandExecutor,
  type ExecBridgeOptions,
  type ServeOptions,
} from "./verbs-ops.ts";
import {
  restart,
  start,
  stop,
  uninstall,
  update,
  type GitRunner,
  type LifecycleBackend,
  type LifecycleDeps,
} from "./verbs-lifecycle.ts";
import { createLaunchdBackend, launchdAgentFile, type LaunchdBackendOptions } from "./backends/launchd.ts";
import {
  hasLaunchd,
  hasSystemd,
  hasWindowsTask,
  selectBackendName,
} from "./types.ts";

type RoutedVerb = (typeof ALL_VERBS)[number];
type RoutedOps = BuildOptions & ServeOptions & ExecBridgeOptions;

type ShellCall = {
  command: string;
  args: string[];
  cwd?: string;
};

type Fixture = {
  root: string;
  configDir: string;
  stateDir: string;
  calls: ShellCall[];
  logs: unknown[][];
  ctx: Ctx;
};

function result(exitCode = 0, stdout = "", stderr = "") {
  return { exitCode, stdout, stderr };
}

async function fixture(name: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `collie-ctl-integration-${name}-`));
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(join(root, "web"), { recursive: true });

  const calls: ShellCall[] = [];
  const logs: unknown[][] = [];
  const ctx: Ctx = {
    rootDir: root,
    configDir,
    stateDir,
    socketPath: join(root, "herdr.sock"),
    log(...args: unknown[]) {
      logs.push(args);
    },
    shell: async (command, args = [], options = {}) => {
      calls.push({ command, args: [...args], cwd: options.cwd });
      return result();
    },
  };

  return { root, configDir, stateDir, calls, logs, ctx };
}

async function withFixture<T>(
  name: string,
  body: (value: Fixture) => Promise<T>,
): Promise<T> {
  const value = await fixture(name);
  try {
    return await body(value);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
}

function loggedText(value: Fixture): string {
  return value.logs.flatMap((line) => line.map((part) => String(part))).join("\n");
}

function recordingBackend(events: string[], failure?: string): LifecycleBackend {
  const operation = async (name: string): Promise<void> => {
    events.push(name);
    if (failure === name) throw new Error(`${name} failed`);
  };
  return {
    install: async () => operation("install"),
    start: async () => operation("start"),
    stop: async () => operation("stop"),
    uninstall: async () => operation("uninstall"),
  };
}

function lifecycleDeps(
  value: Fixture,
  options: {
    events: string[];
    backendFailure?: string;
    ensureFailure?: string;
    readiness?: boolean;
  },
): LifecycleDeps {
  return {
    backend: recordingBackend(options.events, options.backendFailure),
    rootDir: value.root,
    port: 8787,
    publicUrl: "https://collie.example",
    ops: {
      ensureBuild: async () => {
        options.events.push("ensure-build");
        if (options.ensureFailure !== undefined) throw new Error(options.ensureFailure);
      },
      build: async () => {
        options.events.push("build");
      },
      rebuild: async () => {
        options.events.push("rebuild");
      },
      refreshRegistry: async () => {
        options.events.push("refresh-registry");
      },
      serve: async () => {
        options.events.push("serve");
      },
      unserve: async () => {
        options.events.push("unserve");
      },
    },
    waitForReadiness: async (port) => {
      options.events.push(`ready:${port}`);
      return options.readiness ?? true;
    },
  };
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`integration route missing ${name}`);
  return value;
}

/** Route through the real verb modules while replacing every external boundary with a fake. */
async function dispatchInjected(
  ctx: Ctx,
  verb: RoutedVerb,
  args: readonly string[],
  deps: {
    lifecycle?: LifecycleDeps;
    ops?: RoutedOps;
    info?: InfoDeps;
  },
): Promise<void> {
  switch (verb) {
    case "start":
      await start(ctx, required(deps.lifecycle, "lifecycle dependencies"));
      return;
    case "stop":
      await stop(ctx, required(deps.lifecycle, "lifecycle dependencies"));
      return;
    case "restart":
      await restart(ctx, required(deps.lifecycle, "lifecycle dependencies"));
      return;
    case "uninstall":
      await uninstall(ctx, required(deps.lifecycle, "lifecycle dependencies"));
      return;
    case "update":
      await update(ctx, required(deps.lifecycle, "lifecycle dependencies"), args);
      return;
    case "build":
      await build(ctx, required(deps.ops, "operational dependencies"));
      return;
    case "serve":
      await serve(ctx, required(deps.ops, "operational dependencies"));
      return;
    case "unserve":
      await unserve(ctx, required(deps.ops, "operational dependencies"));
      return;
    case "status":
      ctx.log(await infoStatus(ctx, required(deps.info, "info dependencies")));
      return;
    case "url":
      ctx.log(await infoUrl(ctx, required(deps.info, "info dependencies")));
      return;
    case "version":
      ctx.log(await infoVersion(required(deps.info, "info dependencies")));
      return;
    case "qr":
      ctx.log(await infoQr(ctx, required(deps.info, "info dependencies")));
      return;
    case "logs":
      ctx.log(await infoLogs(ctx, required(deps.info, "info dependencies")));
      return;
    case "push-keys":
      await pushKeys(ctx, args, required(deps.ops, "operational dependencies"));
      return;
    case "push-test":
      await pushTest(ctx, args, required(deps.ops, "operational dependencies"));
      return;
    case "exec-bridge":
      await execBridge(ctx, required(deps.ops, "operational dependencies"));
      return;
    case "apply-update":
      // This is the TypeScript equivalent of the shell script's second update phase: build the
      // freshly checked-out tree, then restart it. Registry refresh is deliberately best effort in
      // the old script and has no ctl subprocess in this task's implementation.
      await build(ctx, {
        ...required(deps.ops, "operational dependencies"),
        skipVersionCheck: true,
        skipTypecheck: true,
      });
      await restart(ctx, required(deps.lifecycle, "lifecycle dependencies"));
      return;
  }
}

async function exerciseHappy(verb: RoutedVerb, value: Fixture): Promise<void> {
  switch (verb) {
    case "start": {
      const events: string[] = [];
      await dispatchInjected(value.ctx, verb, [], {
        lifecycle: lifecycleDeps(value, { events }),
      });
      expect(events).toEqual([
        "ensure-build",
        "install",
        "start",
        "ready:8787",
        "serve",
      ]);
      expect(loggedText(value)).toContain("https://collie.example");
      return;
    }
    case "stop": {
      const events: string[] = [];
      await dispatchInjected(value.ctx, verb, [], {
        lifecycle: lifecycleDeps(value, { events }),
      });
      expect(events).toEqual(["stop"]);
      return;
    }
    case "restart": {
      const events: string[] = [];
      await dispatchInjected(value.ctx, verb, [], {
        lifecycle: lifecycleDeps(value, { events }),
      });
      expect(events).toEqual(["stop", "start"]);
      return;
    }
    case "uninstall": {
      const events: string[] = [];
      const pidFile = join(value.configDir, "collie.pid");
      await writeFile(pidFile, "421\n", "utf8");
      await dispatchInjected(value.ctx, verb, [], {
        lifecycle: lifecycleDeps(value, { events }),
      });
      expect(events).toEqual(["stop", "unserve", "uninstall"]);
      expect(await Bun.file(pidFile).exists()).toBe(false);
      expect(await Bun.file(join(value.configDir, ".env")).exists()).toBe(false);
      return;
    }
    case "update": {
      const events: string[] = [];
      const gitCalls: string[][] = [];
      let head = 0;
      const deps = lifecycleDeps(value, { events });
      deps.readText = async (path) =>
        path.endsWith("herdr-plugin.toml") ? 'version = "0.32.0"\n' : "";
      const git: GitRunner = async (args) => {
        gitCalls.push([...args]);
        const command = args.join(" ");
        if (command === "rev-parse --git-dir") return result(0, ".git\n");
        if (command === "symbolic-ref -q HEAD") return result(0, "refs/heads/main\n");
        if (command === "rev-parse HEAD") {
          head += 1;
          return result(0, `head-${head}\n`);
        }
        if (command === "rev-parse --abbrev-ref --symbolic-full-name @{u}") {
          return result(0, "origin/main\n");
        }
        if (command === "rev-parse origin/main^{commit}") {
          return result(0, "target-commit\n");
        }
        if (command === "show target-commit:herdr-plugin.toml") {
          return result(0, 'version = "0.32.1"\n');
        }
        return result();
      };
      deps.git = git;

      await dispatchInjected(value.ctx, verb, [], { lifecycle: deps });
      expect(gitCalls).toContainEqual(["fetch", "origin"]);
      expect(gitCalls).toContainEqual(["merge", "--ff-only", "target-commit"]);
      expect(events).toEqual(["rebuild", "stop", "start", "refresh-registry"]);
      expect(loggedText(value)).toContain("update complete");
      return;
    }
    case "build": {
      const calls: string[][] = [];
      const executor: CommandExecutor = async (argv) => {
        calls.push([...argv]);
        if (argv[1] === "run" && argv[2] === "build") {
          await mkdir(join(value.root, "web", "dist-staging"), { recursive: true });
          await writeFile(join(value.root, "web", "dist-staging", "index.html"), "new", "utf8");
        }
        return result();
      };
      await dispatchInjected(value.ctx, verb, [], {
        ops: { executor, bun: "fake-bun", skipVersionCheck: true, skipTypecheck: true },
      });
      expect(await readFile(join(value.root, "web", "dist", "index.html"), "utf8")).toBe("new");
      expect(calls).toContainEqual(["fake-bun", "install"]);
      expect(calls.some((argv) => argv[1] === "run" && argv[2] === "build")).toBe(true);
      return;
    }
    case "serve": {
      const calls: string[][] = [];
      const executor: CommandExecutor = async (argv) => {
        calls.push([...argv]);
        if (argv[1] === "serve" && argv[2] === "status") {
          return result(0, JSON.stringify({ TCP: {}, Web: {} }));
        }
        if (argv[1] === "status") {
          return result(0, JSON.stringify({ Self: { DNSName: "host.example." } }));
        }
        if (argv[1] === "serve" && argv[2] === "--bg") return result();
        return result(9, "", "unexpected fake tailscale call");
      };
      await dispatchInjected(value.ctx, verb, [], {
        ops: { executor, mode: "http", port: 8787 },
      });
      expect(await readFile(join(value.configDir, "tailscale-managed-handler"), "utf8")).toBe(
        "http:8787|host.example:8787|http://127.0.0.1:8787\n",
      );
      expect(calls).toContainEqual(["tailscale", "serve", "status", "--json"]);
      expect(calls).toContainEqual(["tailscale", "status", "--json"]);
      return;
    }
    case "unserve": {
      const mappingFile = join(value.configDir, "tailscale-managed-handler");
      await writeFile(mappingFile, "http:8787|host.example:8787|http://127.0.0.1:8787\n", "utf8");
      const executor: CommandExecutor = async (argv) => {
        if (argv[1] === "serve" && argv[2] === "status") {
          return result(
            0,
            JSON.stringify({
              TCP: { "8787": { HTTP: true } },
              Web: {
                "host.example:8787": {
                  Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } },
                },
              },
            }),
          );
        }
        if (argv.at(-1) === "off") return result();
        return result(9, "", "unexpected fake tailscale call");
      };
      await dispatchInjected(value.ctx, verb, [], { ops: { executor } });
      expect(await Bun.file(mappingFile).exists()).toBe(false);
      expect(value.calls.some((call) => call.args.includes("reset"))).toBe(false);
      return;
    }
    case "status": {
      const socket = value.ctx.socketPath;
      const mapping = join(value.configDir, "tailscale-managed-handler");
      const files = new Map<string, string>([
        [socket, "socket"],
        [mapping, "http:8787|host.example:8787|http://127.0.0.1:8787\n"],
      ]);
      await dispatchInjected(value.ctx, verb, [], {
        info: {
          backend: { kind: "windows", isActive: async () => true },
          exists: async (path) => files.has(path),
          readText: async (path) => files.get(path) ?? "",
        },
      });
      expect(loggedText(value)).toContain("running");
      expect(loggedText(value)).toContain("backend: active (windows)");
      expect(loggedText(value)).toContain("serve: http://host.example:8787 -> http://127.0.0.1:8787");
      return;
    }
    case "url": {
      const mapping = join(value.configDir, "tailscale-managed-handler");
      await dispatchInjected(value.ctx, verb, [], {
        info: {
          exists: async (path) => path === mapping,
          readText: async () => "https:443|host.example:443|http://127.0.0.1:8787\n",
        },
      });
      expect(loggedText(value)).toContain("https://host.example");
      return;
    }
    case "version": {
      await dispatchInjected(value.ctx, verb, [], {
        info: { readPackageJson: async () => '{"version":"0.32.0"}' },
      });
      expect(loggedText(value)).toContain("0.32.0");
      return;
    }
    case "qr": {
      await dispatchInjected(value.ctx, verb, [], {
        info: {
          publicUrl: "https://collie.example",
          renderQr: async (url) => `QR:${url}`,
        },
      });
      expect(loggedText(value)).toContain("QR:https://collie.example");
      return;
    }
    case "logs": {
      await dispatchInjected(value.ctx, verb, [], {
        info: {
          backend: { kind: "windows", isActive: async () => true },
          tailFile: async (path, lines) => `${path}:${lines}:tail`,
        },
      });
      expect(loggedText(value)).toContain("collie.log:50:tail");
      return;
    }
    case "push-keys": {
      const envFile = join(value.configDir, ".env");
      await writeFile(envFile, "COLLIE_VAPID_PUBLIC=public\n", "utf8");
      const calls: string[][] = [];
      const executor: CommandExecutor = async (argv) => {
        calls.push([...argv]);
        return result();
      };
      await dispatchInjected(value.ctx, verb, ["--check"], {
        ops: { executor, bun: "fake-bun" },
      });
      expect(calls).toEqual([["fake-bun", "scripts/push-keys.ts", envFile, "--check"]]);
      return;
    }
    case "push-test": {
      const envFile = join(value.configDir, ".env");
      await writeFile(envFile, "COLLIE_VAPID_PUBLIC=public\n", "utf8");
      const calls: string[][] = [];
      const executor: CommandExecutor = async (argv) => {
        calls.push([...argv]);
        return result();
      };
      await dispatchInjected(value.ctx, verb, ["hello"], {
        ops: { executor, bun: "fake-bun" },
      });
      expect(calls).toEqual([["fake-bun", `--env-file=${envFile}`, "scripts/push-test.ts", "hello"]]);
      return;
    }
    case "exec-bridge": {
      let argvSeen: string[] | undefined;
      const options: ExecBridgeOptions = {
        bun: "fake-bun",
        spawner: async (argv) => {
          argvSeen = [...argv];
          return 0;
        },
      };
      await dispatchInjected(value.ctx, verb, [], { ops: options });
      expect(argvSeen).toEqual([
        "fake-bun",
        join(value.root, "bridge", "index.ts"),
      ]);
      return;
    }
    case "apply-update": {
      const events: string[] = [];
      const executor: CommandExecutor = async (argv) => {
        if (argv[1] === "run" && argv[2] === "build") {
          await mkdir(join(value.root, "web", "dist-staging"), { recursive: true });
          await writeFile(join(value.root, "web", "dist-staging", "index.html"), "updated", "utf8");
        }
        return result();
      };
      await dispatchInjected(value.ctx, verb, [], {
        lifecycle: lifecycleDeps(value, { events }),
        ops: { executor, bun: "fake-bun" },
      });
      expect(await readFile(join(value.root, "web", "dist", "index.html"), "utf8")).toBe("updated");
      expect(events).toEqual(["stop", "start"]);
      return;
    }
  }
}

async function exerciseFailure(verb: RoutedVerb, value: Fixture): Promise<void> {
  switch (verb) {
    case "start": {
      const events: string[] = [];
      await expect(
        dispatchInjected(value.ctx, verb, [], {
          lifecycle: lifecycleDeps(value, { events, ensureFailure: "initial build failed" }),
        }),
      ).rejects.toThrow("initial build failed");
      expect(events).toEqual(["ensure-build"]);
      return;
    }
    case "stop": {
      const events: string[] = [];
      await expect(
        dispatchInjected(value.ctx, verb, [], {
          lifecycle: lifecycleDeps(value, { events, backendFailure: "stop" }),
        }),
      ).rejects.toThrow("stop failed");
      return;
    }
    case "restart": {
      const events: string[] = [];
      await expect(
        dispatchInjected(value.ctx, verb, [], {
          lifecycle: lifecycleDeps(value, { events, backendFailure: "start" }),
        }),
      ).rejects.toThrow("start failed");
      expect(events).toEqual(["stop", "start"]);
      return;
    }
    case "uninstall": {
      const events: string[] = [];
      await expect(
        dispatchInjected(value.ctx, verb, [], {
          lifecycle: lifecycleDeps(value, { events, backendFailure: "stop" }),
        }),
      ).rejects.toThrow("stop failed");
      expect(events).toEqual(["stop"]);
      return;
    }
    case "update": {
      const events: string[] = [];
      const deps = lifecycleDeps(value, { events });
      deps.git = async () => result(128, "", "git checkout missing");
      await expect(dispatchInjected(value.ctx, verb, [], { lifecycle: deps })).rejects.toThrow(
        "is not a git checkout",
      );
      expect(events).toEqual([]);
      return;
    }
    case "build": {
      const executor: CommandExecutor = async (argv) =>
        argv[1] === "run" && argv[2] === "build"
          ? result(23, "", "synthetic web failure")
          : result();
      await expect(
        dispatchInjected(value.ctx, verb, [], {
          ops: { executor, bun: "fake-bun", skipVersionCheck: true, skipTypecheck: true },
        }),
      ).rejects.toThrow("synthetic web failure");
      return;
    }
    case "serve": {
      const executor: CommandExecutor = async (argv) =>
        argv[1] === "serve" && argv[2] === "status"
          ? result(17, "", "synthetic tailscale failure")
          : result();
      await expect(
        dispatchInjected(value.ctx, verb, [], { ops: { executor, mode: "http", port: 8787 } }),
      ).rejects.toThrow("synthetic tailscale failure");
      expect(await Bun.file(join(value.configDir, "tailscale-managed-handler")).exists()).toBe(false);
      return;
    }
    case "unserve": {
      const mappingFile = join(value.configDir, "tailscale-managed-handler");
      await writeFile(mappingFile, "http:8787|host.example:8787|http://127.0.0.1:8787\n", "utf8");
      const executor: CommandExecutor = async () => result(19, "", "synthetic tailscale status failure");
      await expect(dispatchInjected(value.ctx, verb, [], { ops: { executor } })).rejects.toThrow(
        "synthetic tailscale status failure",
      );
      expect(await Bun.file(mappingFile).exists()).toBe(true);
      return;
    }
    case "status": {
      await expect(
        dispatchInjected(value.ctx, verb, [], {
          info: {
            backend: {
              kind: "windows",
              isActive: async () => {
                throw new Error("status probe failed");
              },
            },
            exists: async () => false,
          },
        }),
      ).rejects.toThrow("status probe failed");
      return;
    }
    case "url": {
      await expect(
        dispatchInjected(value.ctx, verb, [], {
          info: { exists: async () => false },
        }),
      ).rejects.toThrow("no Collie-managed tailscale serve mapping found");
      return;
    }
    case "version": {
      await expect(
        dispatchInjected(value.ctx, verb, [], {
          info: { readPackageJson: async () => '{"name":"collie"}' },
        }),
      ).rejects.toThrow("version string");
      return;
    }
    case "qr": {
      await expect(
        dispatchInjected(value.ctx, verb, [], {
          info: {
            publicUrl: "https://collie.example",
            renderQr: async () => {
              throw new Error("qr renderer failed");
            },
          },
        }),
      ).rejects.toThrow("qr renderer failed");
      return;
    }
    case "logs": {
      await expect(
        dispatchInjected(value.ctx, verb, [], {
          info: {
            backend: { kind: "windows", isActive: async () => true },
            tailFile: async () => {
              throw new Error("log read failed");
            },
          },
        }),
      ).rejects.toThrow("log read failed");
      return;
    }
    case "push-keys": {
      const executor: CommandExecutor = async () => result(31, "", "push keys failed");
      await expect(
        dispatchInjected(value.ctx, verb, [], { ops: { executor, bun: "fake-bun" } }),
      ).rejects.toThrow("push keys failed");
      return;
    }
    case "push-test": {
      const executor: CommandExecutor = async () => result(32, "", "push test failed");
      await expect(
        dispatchInjected(value.ctx, verb, [], { ops: { executor, bun: "fake-bun" } }),
      ).rejects.toThrow("push test failed");
      return;
    }
    case "exec-bridge": {
      const options: ExecBridgeOptions = {
        bun: "fake-bun",
        spawner: async () => 33,
      };
      await expect(dispatchInjected(value.ctx, verb, [], { ops: options })).rejects.toThrow(
        "command failed (33)",
      );
      return;
    }
    case "apply-update": {
      const events: string[] = [];
      const executor: CommandExecutor = async (argv) =>
        argv[1] === "run" && argv[2] === "build"
          ? result(34, "", "apply update build failed")
          : result();
      await expect(
        dispatchInjected(value.ctx, verb, [], {
          lifecycle: lifecycleDeps(value, { events }),
          ops: { executor, bun: "fake-bun" },
        }),
      ).rejects.toThrow("apply update build failed");
      expect(events).toEqual([]);
      return;
    }
  }
}

type CapturedDispatch = {
  code: number;
  stdout: string[];
  stderr: string[];
};

async function captureDispatch(argv: readonly string[]): Promise<CapturedDispatch> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const collectOut = ((...args: unknown[]) => {
    stdout.push(args.map(String).join(" "));
  }) as typeof console.log;
  const collectErr = ((...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  }) as typeof console.error;
  const originalLog = console.log;
  const originalError = console.error;
  console.log = collectOut;
  console.error = collectErr;
  try {
    return { code: await dispatch(argv), stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe("ctl integration dispatch", () => {
  test("--help lists every public and internal verb", async () => {
    const captured = await captureDispatch(["--help"]);
    expect(captured.code).toBe(0);
    expect(captured.stdout).toEqual([USAGE]);
    expect(captured.stderr).toEqual([]);
    for (const verb of ALL_VERBS) expect(captured.stdout[0]).toContain(`  ${verb}`);
  });

  test("unknown verbs return exit status 2 and usage on stderr", async () => {
    const captured = await captureDispatch(["not-a-ctl-verb"]);
    expect(captured.code).toBe(2);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr.join("\n")).toContain("unknown verb: not-a-ctl-verb");
    expect(captured.stderr.join("\n")).toContain(USAGE);
  });

  for (const verb of ALL_VERBS) {
    test(`${verb} happy path dispatches through injected dependencies`, async () => {
      await withFixture(`happy-${verb}`, (value) => exerciseHappy(verb, value));
    });

    test(`${verb} primary failure propagates through dispatch`, async () => {
      await withFixture(`failure-${verb}`, (value) => exerciseFailure(verb, value));
    });
  }

  test("start reports the readiness timeout without claiming readiness", async () => {
    await withFixture("readiness-timeout", async (value) => {
      const events: string[] = [];
      await expect(
        dispatchInjected(value.ctx, "start", [], {
          lifecycle: lifecycleDeps(value, { events, readiness: false }),
        }),
      ).rejects.toThrow("did not become ready on 127.0.0.1:8787");
      expect(events).toEqual(["ensure-build", "install", "start", "ready:8787"]);
      expect(value.logs).toEqual([]);
    });
  });

  test("launchd lifecycle and status stay hermetic and do not leak .env secrets", async () => {
    await withFixture("launchd", async (value) => {
      const secret = "super-secret-signing-key";
      await writeFile(join(value.configDir, ".env"), `COLLIE_VAPID_PRIVATE=${secret}\n`, "utf8");
      const options: LaunchdBackendOptions = {
        homeDir: join(value.root, "home"),
        uid: 42,
        rootDir: value.root,
        bun: "fake-bun",
      };
      const backend = createLaunchdBackend(options);
      await backend.install(value.ctx);
      const plist = launchdAgentFile(options);
      expect(await readFile(plist, "utf8")).not.toContain(secret);

      await backend.start(value.ctx);
      await backend.stop(value.ctx);
      expect(value.calls.map((call) => [call.command, ...call.args])).toEqual([
        ["launchctl", "bootout", "gui/42/herdr.collie"],
        ["launchctl", "enable", "gui/42/herdr.collie"],
        ["launchctl", "bootstrap", "gui/42", plist],
        ["launchctl", "disable", "gui/42/herdr.collie"],
        ["launchctl", "bootout", "gui/42/herdr.collie"],
      ]);

      const activeCtx: Ctx = {
        ...value.ctx,
        shell: async () => result(0, "state = running\npid = 4242\n"),
      };
      expect(await backend.isActive(activeCtx)).toBe(true);
      const statusText = await infoStatus(activeCtx, {
        backend: { kind: "launchd", isActive: () => backend.isActive(activeCtx) },
        exists: async (path) => path === activeCtx.socketPath,
      });
      expect(statusText).toContain("backend: active (launchd)");
      expect(statusText).toContain("socket: present");

      await backend.uninstall(value.ctx);
      expect(await Bun.file(plist).exists()).toBe(false);
    });
  });

  test("backend selection checks systemd, launchd, then Windows Task Scheduler", () => {
    const originalPlatform = process.platform;
    const bunApi = Bun as unknown as {
      which: typeof Bun.which;
      spawnSync: typeof Bun.spawnSync;
    };
    const originalWhich = bunApi.which;
    const originalSpawnSync = bunApi.spawnSync;
    const available = new Set<string>();
    const whichCalls: string[] = [];
    let systemdHealthy = false;
    let spawnCalls = 0;

    bunApi.which = ((name: string) => {
      whichCalls.push(name);
      return available.has(name) ? name : null;
    }) as typeof Bun.which;
    bunApi.spawnSync = (() => {
      spawnCalls += 1;
      return { success: systemdHealthy };
    }) as unknown as typeof Bun.spawnSync;

    const setPlatform = (platform: typeof process.platform): void => {
      Object.defineProperty(process, "platform", { configurable: true, value: platform });
    };
    const resetScenario = (): void => {
      available.clear();
      whichCalls.length = 0;
      systemdHealthy = false;
      spawnCalls = 0;
    };

    try {
      setPlatform("linux");
      available.add("systemctl");
      systemdHealthy = true;
      expect(selectBackendName()).toBe("systemd");
      expect(whichCalls).toEqual(["systemctl"]);
      expect(spawnCalls).toBe(1);
      expect(hasSystemd()).toBe(true);

      resetScenario();
      setPlatform("darwin");
      available.add("launchctl");
      expect(selectBackendName()).toBe("launchd");
      expect(whichCalls).toEqual(["systemctl", "launchctl"]);
      expect(hasLaunchd()).toBe(true);

      resetScenario();
      setPlatform("win32");
      available.add("schtasks");
      expect(selectBackendName()).toBe("windows-task");
      expect(whichCalls).toEqual(["systemctl", "schtasks"]);
      expect(hasWindowsTask()).toBe(true);

      resetScenario();
      setPlatform("win32");
      expect(selectBackendName()).toBeUndefined();
      expect(whichCalls).toEqual(["systemctl", "schtasks", "schtasks.exe"]);
    } finally {
      bunApi.which = originalWhich;
      bunApi.spawnSync = originalSpawnSync;
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    }
  });
});

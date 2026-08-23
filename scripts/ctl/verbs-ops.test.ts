import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  atomicSwapDist,
  build,
  execBridge,
  parseManagedMapping,
  pushTest,
  readManagedMapping,
  refreshRegistry,
  serializeManagedMapping,
  serve,
  tailscaleRootAvailability,
  tailscaleRootFingerprint,
  unserve,
  writeManagedMapping,
  type CommandExecutor,
  type ManagedServeMapping,
  type OpsContext,
} from "./verbs-ops.ts";

async function fixture(): Promise<{ root: string; ctx: OpsContext }> {
  const root = await mkdtemp(join(tmpdir(), "collie-ctl-ops-"));
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  await mkdir(join(root, "web"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  return { root, ctx: { rootDir: root, configDir, stateDir, socketPath: join(root, "herdr.sock") } };
}

async function clean(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

function result(exitCode = 0, stdout = "", stderr = "") {
  return { exitCode, stdout, stderr };
}

const mapping: ManagedServeMapping = {
  mode: "http",
  port: 8787,
  handler: "http:8787",
  hostPort: "host.example:8787",
  proxy: "http://127.0.0.1:8787",
};

const serveStatus = {
  TCP: { "8787": { HTTP: true } },
  Web: {
    "host.example:8787": {
      Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } },
    },
  },
};

describe("ctl operational verbs", () => {
  test("swaps a successful staged build and leaves no staging directory", async () => {
    const { root, ctx } = await fixture();
    try {
      const dist = join(root, "web", "dist");
      await mkdir(dist, { recursive: true });
      await writeFile(join(dist, "index.html"), "old", "utf8");
      const calls: string[] = [];
      const executor: CommandExecutor = async (argv, options) => {
        calls.push(`${argv.join(" ")} @ ${options?.cwd ?? ""}`);
        if (argv.includes("build")) {
          const staging = join(root, "web", "dist-staging");
          await mkdir(staging, { recursive: true });
          await writeFile(join(staging, "index.html"), "new", "utf8");
        }
        return result();
      };

      await build(ctx, { executor });

      expect(await readFile(join(dist, "index.html"), "utf8")).toBe("new");
      await expect(readFile(join(root, "web", "dist-staging"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(calls[0]).toContain(`${process.execPath} scripts/check-version.ts`);
      expect(
        calls.some((call) => call.includes(`${process.execPath} run typecheck`)),
      ).toBe(true);
      expect(
        calls.some(
          (call) =>
            call.includes(`${process.execPath} install`) &&
            call.includes(join(root, "web")),
        ),
      ).toBe(true);
    } finally {
      await clean(root);
    }
  });

  test("a build failure propagates its non-zero status and preserves the live dist", async () => {
    const { root, ctx } = await fixture();
    try {
      const dist = join(root, "web", "dist");
      await mkdir(dist, { recursive: true });
      await writeFile(join(dist, "index.html"), "live", "utf8");
      const executor: CommandExecutor = async (argv) =>
        argv.includes("build") ? result(23, "", "synthetic web failure") : result();

      await expect(build(ctx, { executor })).rejects.toMatchObject({ exitCode: 23 });
      expect(await readFile(join(dist, "index.html"), "utf8")).toBe("live");
    } finally {
      await clean(root);
    }
  });

  test("rolls a failed directory swap back to the original dist", async () => {
    const { root } = await fixture();
    try {
      const dist = join(root, "web", "dist");
      const staging = join(root, "web", "dist-staging");
      await mkdir(dist, { recursive: true });
      await mkdir(staging, { recursive: true });
      await writeFile(join(dist, "index.html"), "live", "utf8");
      await writeFile(join(staging, "index.html"), "candidate", "utf8");
      await expect(
        atomicSwapDist(staging, dist, {
          rename: async (from, to) => {
            if (from === staging) throw new Error("synthetic rename failure");
            await rename(from, to);
          },
        }),
      ).rejects.toThrow("synthetic rename failure");
      expect(await readFile(join(dist, "index.html"), "utf8")).toBe("live");
    } finally {
      await clean(root);
    }
  });

  test("records and verifies only the exact owned Tailscale mapping", async () => {
    const { root, ctx } = await fixture();
    try {
      const file = join(ctx.configDir, "tailscale-managed-handler");
      const encoded = serializeManagedMapping(mapping);
      expect(parseManagedMapping(encoded)).toEqual(mapping);
      await writeManagedMapping(file, mapping);
      expect(await readManagedMapping(file)).toEqual(mapping);
      expect(tailscaleRootFingerprint(serveStatus, mapping.hostPort, mapping.port)).toBe(
        "http|proxy:http://127.0.0.1:8787",
      );
      expect(tailscaleRootAvailability(serveStatus, 8787, "http", mapping.proxy)).toBe("adoptable");
      expect(
        tailscaleRootAvailability(
          { TCP: { "8787": { HTTP: true } }, Web: { "host.example:8787": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } } },
          8787,
          "http",
          mapping.proxy,
        ),
      ).toBe("occupied");
    } finally {
      await clean(root);
    }
  });

  test("serve writes ownership and unserve removes only that mapping", async () => {
    const { root, ctx } = await fixture();
    try {
      let current: unknown = { TCP: {}, Web: {} };
      const calls: string[][] = [];
      const executor: CommandExecutor = async (argv) => {
        calls.push(argv);
        if (argv[0] !== "tailscale") return result();
        if (argv[1] === "serve" && argv[2] === "status") return result(0, JSON.stringify(current));
        if (argv[1] === "status") return result(0, JSON.stringify({ Self: { DNSName: "host.example." } }));
        if (argv[1] === "serve" && argv[2] === "--bg") {
          current = serveStatus;
          return result();
        }
        if (argv[1] === "serve" && argv.at(-1) === "off") {
          current = { TCP: {}, Web: {} };
          return result();
        }
        return result(2, "", "unexpected tailscale command");
      };

      await serve(ctx, { executor, mode: "http", port: 8787 });
      expect(await readManagedMapping(join(ctx.configDir, "tailscale-managed-handler"))).toEqual(mapping);
      await unserve(ctx, { executor });
      expect(await readManagedMapping(join(ctx.configDir, "tailscale-managed-handler"))).toBeNull();
      expect(calls.some((argv) => argv.includes("reset"))).toBe(false);
      expect(calls).toContainEqual(["tailscale", "serve", "--http=8787", "--set-path=/", "off"]);
    } finally {
      await clean(root);
    }
  });

  test("wrapper failures are not swallowed", async () => {
    const { root, ctx } = await fixture();
    try {
      const executor: CommandExecutor = async (argv) =>
        argv.some((part) => part.endsWith("push-test.ts")) ? result(31, "", "synthetic push failure") : result();
      await expect(pushTest(ctx, ["title"], { executor })).rejects.toMatchObject({ exitCode: 31 });
    } finally {
      await clean(root);
    }
  });

  test("refreshes Herdr registration for a linked checkout", async () => {
    const { root, ctx } = await fixture();
    try {
      const calls: string[][] = [];
      await refreshRegistry(ctx, {
        executor: async (argv) => {
          calls.push(argv);
          return result();
        },
      });

      expect(calls).toEqual([["herdr", "plugin", "link", root]]);
    } finally {
      await clean(root);
    }
  });

  test("adapts the shared ctl shell contract without invoking a command interpreter", async () => {
    const { root, ctx: base } = await fixture();
    try {
      let invocation: { command: string; args: readonly string[]; cwd?: string } | undefined;
      const ctx: OpsContext = {
        ...base,
        shell: async (
          command: string,
          args: readonly string[] = [],
          options: { cwd?: string } = {},
        ) => {
          invocation = { command, args, cwd: options.cwd };
          return result();
        },
      };
      await pushTest(ctx, ["title"]);
      expect(invocation).toEqual({
        command: process.execPath,
        args: ["scripts/push-test.ts", "title"],
        cwd: root,
      });
    } finally {
      await clean(root);
    }
  });

  test("exec-bridge passes the bridge environment and redirects both streams", async () => {
    const { root, ctx } = await fixture();
    try {
      const logFile = join(ctx.stateDir, "collie.log");
      const configuredSocket = join(root, "custom-herdr.sock");
      await writeFile(logFile, "stale failure\n", "utf8");
      await writeFile(
        join(ctx.configDir, ".env"),
        `HERDR_SOCKET_PATH=${configuredSocket}\n`,
        "utf8",
      );
      let received: { argv: string[]; options: { cwd: string; env: Record<string, string>; stdout: unknown; stderr: unknown } } | undefined;
      await execBridge(ctx, {
        bun: "bun",
        spawner: async (argv, options) => {
          received = { argv, options };
          return 0;
        },
      });
      expect(received?.argv).toEqual(["bun", join(root, "bridge", "index.ts")]);
      expect(received?.options.cwd).toBe(root);
      expect(received?.options.stdout).toBe(join(ctx.stateDir, "collie.log"));
      expect(received?.options.stderr).toBe(join(ctx.stateDir, "collie.log"));
      expect(received?.options.env.HERDR_PLUGIN_CONFIG_DIR).toBe(ctx.configDir);
      expect(received?.options.env.HERDR_PLUGIN_STATE_DIR).toBe(ctx.stateDir);
      expect(received?.options.env.HERDR_SOCKET_PATH).toBe(configuredSocket);
      expect(await readFile(logFile, "utf8")).toBe("");
    } finally {
      await clean(root);
    }
  });
});

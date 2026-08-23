import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { runShell } from "./main.ts";
import {
  parseReleaseTags,
  restart,
  start,
  stop,
  uninstall,
  update,
  type LifecycleBackend,
  type LifecycleDeps,
} from "./verbs-lifecycle.ts";
import type { Ctx } from "./types.ts";

async function fixture(name: string): Promise<{ root: string; ctx: Ctx }> {
  const root = await mkdtemp(join(tmpdir(), `collie-ctl-lifecycle-${name}-`));
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  return {
    root,
    ctx: {
      rootDir: root,
      configDir,
      stateDir,
      socketPath: join(root, "herdr.sock"),
      log() {},
      shell: runShell,
    },
  };
}

async function clean(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

function backend(calls: string[]): LifecycleBackend {
  return {
    async install() {
      calls.push("install");
    },
    async start() {
      calls.push("start");
    },
    async stop() {
      calls.push("stop");
    },
    async uninstall() {
      calls.push("uninstall");
    },
  };
}

function deps(
  ctx: Ctx,
  calls: string[],
  extra: Partial<LifecycleDeps> = {},
): LifecycleDeps {
  return {
    backend: backend(calls),
    ops: {
      ensureBuild: async () => {
        calls.push("ensure-build");
      },
      build: async () => {
        calls.push("build");
      },
      refreshRegistry: async () => {
        calls.push("refresh-registry");
      },
      serve: async () => {
        calls.push("serve");
      },
      unserve: async () => {
        calls.push("unserve");
      },
    },
    rootDir: ctx.rootDir,
    waitForReadiness: async (port) => {
      calls.push(`ready:${port}`);
      return true;
    },
    ...extra,
  };
}

async function git(root: string, args: string[], expected = 0): Promise<string> {
  const result = await runShell("git", ["-C", root, ...args]);
  expect(result.exitCode, `${args.join(" ")}\n${result.stderr}`).toBe(expected);
  return result.stdout;
}

async function commit(root: string, message: string): Promise<void> {
  await git(root, ["add", "-A"]);
  const result = await runShell("git", [
    "-c",
    "user.name=collie-test",
    "-c",
    "user.email=test@example.invalid",
    "-C",
    root,
    "commit",
    "-qm",
    message,
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
}

async function originRepo(parent: string, version: string): Promise<string> {
  const origin = join(parent, "origin");
  await mkdir(origin, { recursive: true });
  await git(origin, ["init", "-q", "-b", "main"]);
  await writeFile(join(origin, "herdr-plugin.toml"), `version = "${version}"\n`, "utf8");
  await writeFile(join(origin, "VERSION"), version, "utf8");
  await commit(origin, "initial");
  return origin;
}

describe("ctl lifecycle verbs", () => {
  test("start builds once, starts the backend, waits for readiness, and prints its URL", async () => {
    const { root, ctx } = await fixture("start");
    try {
      const calls: string[] = [];
      const output: unknown[][] = [];
      const loggedCtx: Ctx = { ...ctx, log: (...args) => output.push(args) };
      const lifecycle = deps(loggedCtx, calls, { publicUrl: "https://collie.example" });

      await start(loggedCtx, lifecycle);

      expect(calls).toEqual(["ensure-build", "install", "start", "ready:8787", "serve"]);
      expect(output.flat().join(" ")).toContain("https://collie.example");
    } finally {
      await clean(root);
    }
  });

  test("start keeps the ready bridge running when front-door publication fails", async () => {
    const { root, ctx } = await fixture("start-serve-failure");
    try {
      const calls: string[] = [];
      const output: unknown[][] = [];
      const loggedCtx: Ctx = { ...ctx, log: (...args) => output.push(args) };
      const lifecycle = deps(loggedCtx, calls, {
        ops: {
          ensureBuild: async () => {
            calls.push("ensure-build");
          },
          serve: async () => {
            calls.push("serve");
            throw new Error("tailscale unavailable");
          },
        },
      });

      await start(loggedCtx, lifecycle);

      expect(calls).toEqual(["ensure-build", "install", "start", "ready:8787", "serve"]);
      expect(output.flat().join(" ")).toContain("tailscale unavailable");
      expect(output.flat().join(" ")).toContain("http://127.0.0.1:8787");
    } finally {
      await clean(root);
    }
  });

  test("stop and restart delegate to the backend without reinstalling it", async () => {
    const { root, ctx } = await fixture("restart");
    try {
      const calls: string[] = [];
      const lifecycle = deps(ctx, calls);
      await stop(ctx, lifecycle);
      await restart(ctx, lifecycle);
      expect(calls).toEqual(["stop", "stop", "start"]);
    } finally {
      await clean(root);
    }
  });

  test("uninstall removes registration, serve ownership, and pidfile but preserves config and checkout", async () => {
    const { root, ctx } = await fixture("uninstall");
    try {
      const envFile = join(ctx.configDir, ".env");
      const checkoutMarker = join(root, "checkout-marker");
      const pidFile = join(ctx.configDir, "collie.pid");
      await writeFile(envFile, "COLLIE_PORT=9012\n", "utf8");
      await writeFile(checkoutMarker, "checkout", "utf8");
      await writeFile(pidFile, "12345\n", "utf8");
      const calls: string[] = [];
      const lifecycle = deps(ctx, calls);

      await uninstall(ctx, lifecycle);

      expect(calls).toEqual(["stop", "unserve", "uninstall"]);
      expect(await Bun.file(envFile).exists()).toBe(true);
      expect(await Bun.file(checkoutMarker).exists()).toBe(true);
      expect(await Bun.file(pidFile).exists()).toBe(false);
    } finally {
      await clean(root);
    }
  });

  test("start reports a readiness timeout instead of claiming the service is ready", async () => {
    const { root, ctx } = await fixture("timeout");
    try {
      const calls: string[] = [];
      const lifecycle = deps(ctx, calls, {
        waitForReadiness: async () => false,
      });
      await expect(start(ctx, lifecycle)).rejects.toThrow("did not become ready");
      expect(calls).toEqual(["ensure-build", "install", "start"]);
    } finally {
      await clean(root);
    }
  });

  test("advances a linked clone to the pinned upstream commit, then rebuilds and restarts", async () => {
    const { root, ctx } = await fixture("linked");
    try {
      const origin = await originRepo(root, "1.0.0");
      const clone = join(root, "clone");
      const cloneResult = await runShell("git", ["clone", "-q", origin, clone]);
      expect(cloneResult.exitCode, cloneResult.stderr).toBe(0);
      await writeFile(join(origin, "VERSION"), "1.0.1", "utf8");
      await writeFile(join(origin, "herdr-plugin.toml"), 'version = "1.0.1"\n', "utf8");
      await commit(origin, "release");

      const calls: string[] = [];
      const lifecycle = deps(
        { ...ctx, rootDir: clone },
        calls,
        { rootDir: clone },
      );
      await update({ ...ctx, rootDir: clone }, lifecycle);

      expect(await readFile(join(clone, "VERSION"), "utf8")).toBe("1.0.1");
      expect(calls).toContain("build");
      expect(calls).toContain("stop");
      expect(calls).toContain("start");
      expect(calls).toContain("refresh-registry");
      expect((await git(clone, ["symbolic-ref", "--short", "HEAD"])).trim()).toBe("main");
    } finally {
      await clean(root);
    }
  });

  test("refuses a detached checkout when the remote has no release tags", async () => {
    const { root, ctx } = await fixture("detached");
    try {
      const origin = await originRepo(root, "1.0.0");
      const managed = join(root, "managed");
      await mkdir(managed, { recursive: true });
      await git(managed, ["init", "-q"]);
      await git(managed, ["remote", "add", "origin", origin]);
      await git(managed, ["fetch", "-q", "--depth", "1", "origin", "HEAD"]);
      await git(managed, ["checkout", "-q", "--detach", "FETCH_HEAD"]);
      await writeFile(join(origin, "VERSION"), "1.0.1", "utf8");
      await writeFile(join(origin, "herdr-plugin.toml"), 'version = "1.0.1"\n', "utf8");
      await commit(origin, "release");

      const calls: string[] = [];
      const lifecycle = deps({ ...ctx, rootDir: managed }, calls, { rootDir: managed });
      const before = (await git(managed, ["rev-parse", "HEAD"])).trim();

      await expect(update({ ...ctx, rootDir: managed }, lifecycle)).rejects.toThrow(
        "no release tags",
      );

      expect((await git(managed, ["rev-parse", "HEAD"])).trim()).toBe(before);
      expect(await readFile(join(managed, "VERSION"), "utf8")).toBe("1.0.0");
      expect(calls).not.toContain("build");
      expect((await git(managed, ["symbolic-ref", "-q", "HEAD"], 1)).trim()).toBe("");
    } finally {
      await clean(root);
    }
  });

  test("refuses a linked update when the target manifest version is unreadable", async () => {
    const { root, ctx } = await fixture("linked-invalid-version");
    try {
      const origin = await originRepo(root, "1.0.0");
      const clone = join(root, "clone");
      const cloneResult = await runShell("git", ["clone", "-q", origin, clone]);
      expect(cloneResult.exitCode, cloneResult.stderr).toBe(0);
      await writeFile(join(origin, "VERSION"), "untrusted", "utf8");
      await writeFile(join(origin, "herdr-plugin.toml"), "name = \"missing-version\"\n", "utf8");
      await commit(origin, "invalid manifest");
      const before = (await git(clone, ["rev-parse", "HEAD"])).trim();
      const calls: string[] = [];
      const lifecycle = deps({ ...ctx, rootDir: clone }, calls, { rootDir: clone });

      await expect(update({ ...ctx, rootDir: clone }, lifecycle)).rejects.toThrow(
        "cannot verify target version",
      );

      expect((await git(clone, ["rev-parse", "HEAD"])).trim()).toBe(before);
      expect(calls).not.toContain("build");
    } finally {
      await clean(root);
    }
  });

  test("follows detached release tags within the installed major and crosses one major per flag", async () => {
    const { root, ctx } = await fixture("detached-tags");
    try {
      const origin = await originRepo(root, "1.0.0");
      await git(origin, ["tag", "v1.0.0"]);
      await writeFile(join(origin, "VERSION"), "1.1.0", "utf8");
      await writeFile(join(origin, "herdr-plugin.toml"), 'version = "1.1.0"\n', "utf8");
      await commit(origin, "minor release");
      await git(origin, ["tag", "v1.1.0"]);
      await writeFile(join(origin, "VERSION"), "2.0.0", "utf8");
      await writeFile(join(origin, "herdr-plugin.toml"), 'version = "2.0.0"\n', "utf8");
      await commit(origin, "major release");
      await git(origin, ["tag", "v2.0.0"]);

      const managed = join(root, "managed");
      await mkdir(managed, { recursive: true });
      await git(managed, ["init", "-q"]);
      await git(managed, ["remote", "add", "origin", origin]);
      await git(managed, ["fetch", "-q", "--depth", "1", "origin", "refs/tags/v1.0.0"]);
      await git(managed, ["checkout", "-q", "--detach", "FETCH_HEAD"]);
      const calls: string[] = [];
      const lifecycle = deps({ ...ctx, rootDir: managed }, calls, { rootDir: managed });

      await update({ ...ctx, rootDir: managed }, lifecycle);
      expect(await readFile(join(managed, "VERSION"), "utf8")).toBe("1.1.0");
      await update({ ...ctx, rootDir: managed }, lifecycle, ["--major"]);
      expect(await readFile(join(managed, "VERSION"), "utf8")).toBe("2.0.0");
    } finally {
      await clean(root);
    }
  });

  test("refuses a linked major crossing unless --major is supplied", async () => {
    const { root, ctx } = await fixture("major");
    try {
      const origin = await originRepo(root, "1.0.0");
      const clone = join(root, "clone");
      const cloneResult = await runShell("git", ["clone", "-q", origin, clone]);
      expect(cloneResult.exitCode, cloneResult.stderr).toBe(0);
      await writeFile(join(origin, "VERSION"), "2.0.0", "utf8");
      await writeFile(join(origin, "herdr-plugin.toml"), 'version = "2.0.0"\n', "utf8");
      await commit(origin, "major");
      const before = (await git(clone, ["rev-parse", "HEAD"])).trim();
      const calls: string[] = [];
      const lifecycle = deps({ ...ctx, rootDir: clone }, calls, { rootDir: clone });

      await update({ ...ctx, rootDir: clone }, lifecycle);
      expect((await git(clone, ["rev-parse", "HEAD"])).trim()).toBe(before);
      expect(calls).not.toContain("build");

      await update({ ...ctx, rootDir: clone }, lifecycle, ["--major"]);
      expect((await git(clone, ["rev-parse", "HEAD"])).trim()).not.toBe(before);
    } finally {
      await clean(root);
    }
  });

  test("parses annotated and lightweight strict release tags without prereleases", () => {
    expect(
      parseReleaseTags(
        [
          "111 refs/tags/v1.0.0",
          "222 refs/tags/v1.1.0",
          "333 refs/tags/v1.1.0^{}",
          "444 refs/tags/v2.0.0-beta.1",
          "555 refs/tags/v2.0",
        ].join("\n"),
      ),
    ).toEqual([
      expect.objectContaining({ name: "v1.0.0", commit: "111", peeled: false }),
      expect.objectContaining({ name: "v1.1.0", commit: "333", peeled: true }),
    ]);
  });
});

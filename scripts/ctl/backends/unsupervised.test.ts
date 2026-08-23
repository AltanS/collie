import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  createUnsupervisedBackend,
  type DetachedSpawn,
} from "./unsupervised.ts";
import type { Ctx } from "../types.ts";

async function fixture(): Promise<{ readonly root: string; readonly ctx: Ctx }> {
  const root = await mkdtemp(join(tmpdir(), "collie-unsupervised-"));
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
      shell: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    },
  };
}

describe("unsupervised fallback backend", () => {
  test("starts the real ctl entrypoint detached and records its process group", async () => {
    const { root, ctx } = await fixture();
    try {
      const calls: Array<{
        readonly argv: readonly string[];
        readonly detached: boolean;
      }> = [];
      let unrefCount = 0;
      const spawn: DetachedSpawn = (argv, options) => {
        calls.push({ argv, detached: options.detached });
        return {
          pid: 421,
          unref() {
            unrefCount += 1;
          },
        };
      };
      const backend = createUnsupervisedBackend({
        rootDir: root,
        bun: "absolute-bun",
        spawn,
      });

      await backend.start(ctx);

      expect(calls).toEqual([
        {
          argv: [
            "absolute-bun",
            join(root, "scripts", "ctl", "main.ts"),
            "exec-bridge",
          ],
          detached: true,
        },
      ]);
      expect(unrefCount).toBe(1);
      expect(await readFile(join(ctx.configDir, "collie.pid"), "utf8")).toBe("421\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stops the recorded process group and removes its pidfile", async () => {
    const { root, ctx } = await fixture();
    try {
      const signals: Array<{ readonly pid: number; readonly signal: number | string }> = [];
      const backend = createUnsupervisedBackend({
        rootDir: root,
        spawn: () => ({ pid: 421, unref() {} }),
        kill: (pid, signal) => {
          signals.push({ pid, signal });
        },
      });
      await backend.start(ctx);

      await backend.stop(ctx);

      expect(signals).toContainEqual({ pid: -421, signal: "SIGTERM" });
      expect(await Bun.file(join(ctx.configDir, "collie.pid")).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

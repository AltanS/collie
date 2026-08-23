import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Ctx, ShellCommand } from "../types.ts";
import {
  asInstalledBackend,
  bunBinary,
  checkoutRoot,
  tailCommand,
  type BackendFactoryOptions,
  type InstalledServiceBackend,
} from "./common.ts";

const PIDFILE = "collie.pid";

export interface DetachedProcess {
  readonly pid: number;
  unref(): void;
}

export interface DetachedSpawnOptions {
  readonly cwd: string;
  readonly detached: true;
}

export type DetachedSpawn = (
  argv: readonly string[],
  options: DetachedSpawnOptions,
) => DetachedProcess;

export type ProcessKiller = (
  pid: number,
  signal: NodeJS.Signals | 0,
) => void;

export interface UnsupervisedBackendOptions extends BackendFactoryOptions {
  readonly spawn?: DetachedSpawn;
  readonly kill?: ProcessKiller;
}

function defaultSpawn(
  argv: readonly string[],
  options: DetachedSpawnOptions,
): DetachedProcess {
  const child = Bun.spawn([...argv], {
    cwd: options.cwd,
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return {
    pid: child.pid,
    unref() {
      child.unref();
    },
  };
}

function parsePid(text: string): number | undefined {
  const value = text.trim();
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

function isMissingProcess(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ESRCH"
  );
}

export function createUnsupervisedBackend(
  options: UnsupervisedBackendOptions = {},
): InstalledServiceBackend {
  const root = checkoutRoot(options.rootDir);
  const bun = bunBinary(options.bun);
  const spawn = options.spawn ?? defaultSpawn;
  const kill = options.kill ?? process.kill;

  const pidFile = (ctx: Ctx): string => join(ctx.configDir, PIDFILE);

  const stop = async (ctx: Ctx): Promise<void> => {
    let pid: number | undefined;
    try {
      pid = parsePid(await readFile(pidFile(ctx), "utf8"));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    if (pid !== undefined) {
      try {
        kill(-pid, "SIGTERM");
      } catch (error) {
        if (!isMissingProcess(error)) throw error;
      }
    }
    await rm(pidFile(ctx), { force: true });
  };

  return asInstalledBackend({
    async install(): Promise<void> {},

    async start(ctx: Ctx): Promise<void> {
      await stop(ctx);
      await mkdir(ctx.configDir, { recursive: true });
      const currentRoot = ctx.rootDir ?? root;
      const child = spawn(
        [
          bun,
          join(currentRoot, "scripts", "ctl", "main.ts"),
          "exec-bridge",
        ],
        { cwd: currentRoot, detached: true },
      );
      await writeFile(pidFile(ctx), `${child.pid}\n`, "utf8");
      child.unref();
      ctx.log("bridge started (unsupervised fallback)");
    },

    stop,

    async uninstall(ctx: Ctx): Promise<void> {
      await stop(ctx);
    },

    async isActive(ctx: Ctx): Promise<boolean> {
      try {
        const pid = parsePid(await readFile(pidFile(ctx), "utf8"));
        if (pid === undefined) return false;
        kill(pid, 0);
        return true;
      } catch (error) {
        if (
          isMissingProcess(error) ||
          (error instanceof Error && "code" in error && error.code === "ENOENT")
        ) {
          return false;
        }
        throw error;
      }
    },

    logsCmd(ctx: Ctx, lines?: number): ShellCommand {
      return tailCommand(join(ctx.stateDir, "collie.log"), lines);
    },
  });
}

export const unsupervisedBackend = createUnsupervisedBackend();

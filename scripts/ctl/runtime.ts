import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { InstalledServiceBackend } from "./backends/common.ts";
import { checkedShell } from "./backends/common.ts";
import { launchdBackend } from "./backends/launchd.ts";
import { systemdBackend } from "./backends/systemd.ts";
import { unsupervisedBackend } from "./backends/unsupervised.ts";
import { windowsBackend } from "./backends/windows.ts";
import * as info from "./verbs-info.ts";
import * as lifecycle from "./verbs-lifecycle.ts";
import * as ops from "./verbs-ops.ts";
import type { BackendName, Ctx, Verb, VerbHandler } from "./types.ts";
import { selectBackendName, waitForTcpReadiness } from "./types.ts";

export interface RuntimeDependencies {
  readonly backend: () => InstalledServiceBackend | undefined;
  readonly backendKind: () => info.BackendKind | undefined;
  readonly waitForReadiness: typeof waitForTcpReadiness;
  readonly lifecycle: Pick<
    typeof lifecycle,
    "ensureBuild" | "restart" | "start" | "stop" | "uninstall" | "update"
  >;
  readonly info: Pick<typeof info, "logs" | "qr" | "status" | "url" | "version">;
  readonly ops: Pick<
    typeof ops,
    | "build"
    | "execBridge"
    | "pushKeys"
    | "pushTest"
    | "refreshRegistry"
    | "serve"
    | "unserve"
  >;
}

function defaultBackendKind(): info.BackendKind | undefined {
  switch (selectBackendName()) {
    case "windows-task":
      return "windows";
    case "systemd":
      return "systemd";
    case "launchd":
      return "launchd";
    default:
      return undefined;
  }
}

export function backendForName(
  name: BackendName | undefined,
): InstalledServiceBackend {
  switch (name) {
    case "windows-task":
      return windowsBackend;
    case "systemd":
      return systemdBackend;
    case "launchd":
      return launchdBackend;
    default:
      return unsupervisedBackend;
  }
}

function defaultBackend(): InstalledServiceBackend {
  return backendForName(selectBackendName());
}

export const defaultRuntimeDependencies: RuntimeDependencies = {
  backend: defaultBackend,
  backendKind: defaultBackendKind,
  waitForReadiness: waitForTcpReadiness,
  lifecycle,
  info,
  ops,
};

function requireBackend(dependencies: RuntimeDependencies): InstalledServiceBackend {
  const backend = dependencies.backend();
  if (backend === undefined) {
    throw new Error(
      "no supported service supervisor found (systemd, launchd, or Windows Task Scheduler)",
    );
  }
  return backend;
}

function lifecycleOps(dependencies: RuntimeDependencies): lifecycle.LifecycleOps {
  return {
    build: (ctx) => dependencies.ops.build(ctx),
    rebuild: (ctx) => dependencies.ops.build(ctx),
    refreshRegistry: (ctx) => dependencies.ops.refreshRegistry(ctx),
    serve: (ctx) => dependencies.ops.serve(ctx),
    unserve: (ctx) => dependencies.ops.unserve(ctx),
  };
}

function parseConfiguredUrl(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = /^(?:export\s+)?COLLIE_PUBLIC_URL\s*=\s*(.*)$/.exec(line.trim());
    if (match === null) continue;
    const raw = match[1]?.trim() ?? "";
    const value =
      raw.length >= 2 &&
      ((raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'")))
        ? raw.slice(1, -1)
        : raw;
    return value.trim() || undefined;
  }
  return undefined;
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function configuredPublicUrl(ctx: Ctx): Promise<string | undefined> {
  const direct = ctx.env?.COLLIE_PUBLIC_URL ?? process.env.COLLIE_PUBLIC_URL;
  if (direct?.trim()) return direct.trim();
  try {
    return parseConfiguredUrl(await readFile(join(ctx.configDir, ".env"), "utf8"));
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

async function infoDeps(
  ctx: Ctx,
  dependencies: RuntimeDependencies,
): Promise<info.InfoDeps> {
  const backend = dependencies.backend();
  const publicUrl = await configuredPublicUrl(ctx);
  if (backend === undefined) {
    return publicUrl === undefined ? {} : { publicUrl };
  }
  return {
    backend: {
      kind: dependencies.backendKind(),
      isActive: () => backend.isActive(ctx),
      logsCmd: async (lines) => {
        const command = backend.logsCmd(ctx, lines);
        return (await checkedShell(ctx, command.command, command.args)).stdout;
      },
    },
    ...(publicUrl === undefined ? {} : { publicUrl }),
  };
}

export function createHandlers(
  dependencies: RuntimeDependencies = defaultRuntimeDependencies,
): Readonly<Record<Verb, VerbHandler>> {
  const operations = lifecycleOps(dependencies);
  return {
    start: (ctx) =>
      dependencies.lifecycle.start(ctx, {
        backend: requireBackend(dependencies),
        ops: operations,
        ensureBuild: (current) =>
          dependencies.lifecycle.ensureBuild(
            current,
            requireBackend(dependencies),
            operations,
          ),
        waitForReadiness: dependencies.waitForReadiness,
      }),
    stop: (ctx) => dependencies.lifecycle.stop(ctx, requireBackend(dependencies)),
    restart: (ctx) => dependencies.lifecycle.restart(ctx, requireBackend(dependencies)),
    uninstall: (ctx) =>
      dependencies.lifecycle.uninstall(
        ctx,
        requireBackend(dependencies),
        operations,
      ),
    update: (ctx, args) =>
      dependencies.lifecycle.update(ctx, args, {
        backend: requireBackend(dependencies),
        ...operations,
      }),
    build: (ctx) => dependencies.ops.build(ctx),
    serve: (ctx) => dependencies.ops.serve(ctx),
    unserve: (ctx) => dependencies.ops.unserve(ctx),
    status: async (ctx) =>
      ctx.log(
        await dependencies.info.status(
          ctx,
          await infoDeps(ctx, dependencies),
        ),
      ),
    url: async (ctx) =>
      ctx.log(
        await dependencies.info.url(ctx, await infoDeps(ctx, dependencies)),
      ),
    version: async (ctx) => ctx.log(await dependencies.info.version()),
    qr: async (ctx) =>
      ctx.log(
        await dependencies.info.qr(ctx, await infoDeps(ctx, dependencies)),
      ),
    logs: async (ctx, args) =>
      ctx.log(
        await dependencies.info.logs(
          ctx,
          await infoDeps(ctx, dependencies),
          Number(args[0]) || 50,
        ),
      ),
    "push-keys": (ctx, args) => dependencies.ops.pushKeys(ctx, args),
    "push-test": (ctx, args) => dependencies.ops.pushTest(ctx, args),
    "exec-bridge": (ctx) => dependencies.ops.execBridge(ctx),
    "apply-update": async () => {
      throw new Error("apply-update is folded into 'update' by this implementation");
    },
  };
}

export const handlers = createHandlers();

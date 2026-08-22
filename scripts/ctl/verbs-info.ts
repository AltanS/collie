import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderQr as defaultRenderQr } from "../qr.ts";

export interface CtlCtx {
  configDir: string;
  stateDir: string;
  socketPath: string;
  log?: (...args: unknown[]) => void;
  shell?: unknown;
}

export type BackendKind = "windows" | "systemd" | "launchd";

export interface ServiceBackend {
  kind?: BackendKind;
  isActive: () => boolean | Promise<boolean>;
  logsCmd?: (lines: number) => string | Promise<string>;
}

export interface InfoDeps {
  backend?: ServiceBackend | null;
  readText?: (path: string) => Promise<string>;
  exists?: (path: string) => Promise<boolean>;
  tailFile?: (path: string, lines: number) => Promise<string>;
  renderQr?: (url: string) => Promise<string>;
  readPackageJson?: () => Promise<string>;
  publicUrl?: string;
}

export interface ServeRecord {
  mode: "http" | "https";
  port: number;
  hostPort: string;
  proxy: string;
}

type ServeState =
  | { kind: "skipped"; publicUrl: string }
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "mapped"; record: ServeRecord };

interface ResolvedDeps {
  backend: ServiceBackend | null;
  readText: (path: string) => Promise<string>;
  exists: (path: string) => Promise<boolean>;
  tailFile: (path: string, lines: number) => Promise<string>;
  renderQr: (url: string) => Promise<string>;
  readPackageJson: () => Promise<string>;
  publicUrl?: string;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(MODULE_DIR, "../..");
const DEFAULT_PACKAGE_JSON = join(ROOT_DIR, "package.json");
const SERVE_HANDLER_FILE = "tailscale-managed-handler";
const COLLIE_LOG_FILE = "collie.log";

async function defaultReadText(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function tailText(text: string, lines: number): string {
  if (lines <= 0) return "";
  const parts = text.split(/\r?\n/);
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts.slice(-lines).join("\n");
}

async function defaultTailFile(
  path: string,
  lines: number,
  readText: (path: string) => Promise<string>,
): Promise<string> {
  try {
    return tailText(await readText(path), lines);
  } catch (error) {
    if (isMissingFileError(error)) return "(no log)";
    throw error;
  }
}

function resolveDeps(deps: InfoDeps = {}): ResolvedDeps {
  const readText = deps.readText ?? defaultReadText;
  const exists = deps.exists ?? defaultExists;
  return {
    backend: deps.backend ?? null,
    readText,
    exists,
    tailFile: deps.tailFile ?? ((path, lines) => defaultTailFile(path, lines, readText)),
    renderQr: deps.renderQr ?? defaultRenderQr,
    readPackageJson: deps.readPackageJson ?? (() => readText(DEFAULT_PACKAGE_JSON)),
    publicUrl: deps.publicUrl?.trim() || undefined,
  };
}

function parseServeRecord(text: string): ServeRecord | null {
  const line = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  if (line === undefined) return null;
  const parts = line.split("|").map((s) => s.trim());
  if (parts.length !== 3) return null;
  const modePort = parts[0]!;
  const hostPort = parts[1]!;
  const proxy = parts[2]!;
  const match = /^(http|https):(\d+)$/.exec(modePort);
  if (!match || hostPort.length === 0 || proxy.length === 0) return null;
  return {
    mode: match[1]! as "http" | "https",
    port: Number(match[2]!),
    hostPort,
    proxy,
  };
}

export function serveUrl(record: ServeRecord): string {
  if (record.mode === "http") return `http://${record.hostPort}`;
  const host = record.hostPort.endsWith(":443") ? record.hostPort.slice(0, -4) : record.hostPort;
  return `https://${host}`;
}

async function readServeState(ctx: CtlCtx, deps: ResolvedDeps, includePublicUrl: boolean): Promise<ServeState> {
  if (includePublicUrl && deps.publicUrl !== undefined) return { kind: "skipped", publicUrl: deps.publicUrl };
  const path = join(ctx.configDir, SERVE_HANDLER_FILE);
  if (!(await deps.exists(path))) return { kind: "missing" };
  try {
    const record = parseServeRecord(await deps.readText(path));
    return record ? { kind: "mapped", record } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

function formatServeSummary(state: ServeState): string {
  switch (state.kind) {
    case "skipped":
      return `skipped -> ${state.publicUrl}`;
    case "mapped":
      return `${serveUrl(state.record)} -> ${state.record.proxy}`;
    case "invalid":
      return "invalid";
    case "missing":
      return "none";
  }
}

function backendLabel(backend: ServiceBackend | null, active: boolean | null): string {
  if (backend === null) return "unavailable";
  const state = active ? "active" : "inactive";
  return backend.kind === undefined ? state : `${state} (${backend.kind})`;
}

export async function status(ctx: CtlCtx, deps: InfoDeps = {}): Promise<string> {
  const resolved = resolveDeps(deps);
  const socketPresentPromise = resolved.exists(ctx.socketPath);
  const backendActivePromise =
    resolved.backend === null ? Promise.resolve<boolean | null>(null) : Promise.resolve(resolved.backend.isActive());
  const servePromise = readServeState(ctx, resolved, true);
  const [socketPresent, backendActiveRaw, serve] = await Promise.all([
    socketPresentPromise,
    backendActivePromise,
    servePromise,
  ]);
  const backendActive = backendActiveRaw === null ? null : Boolean(backendActiveRaw);
  const state = resolved.backend === null ? "no-backend" : socketPresent ? "running" : "stopped";
  return [
    state,
    `  backend: ${backendLabel(resolved.backend, backendActive)}`,
    `  socket: ${socketPresent ? "present" : "missing"}`,
    `  serve: ${formatServeSummary(serve)}`,
  ].join("\n");
}

export async function url(ctx: CtlCtx, deps: InfoDeps = {}): Promise<string> {
  const resolved = resolveDeps(deps);
  const serve = await readServeState(ctx, resolved, false);
  if (serve.kind === "mapped") return serveUrl(serve.record);
  if (serve.kind === "invalid") throw new Error("invalid Collie-managed tailscale serve mapping");
  throw new Error("no Collie-managed tailscale serve mapping found");
}

export async function logs(ctx: CtlCtx, deps: InfoDeps = {}, lines = 50): Promise<string> {
  const resolved = resolveDeps(deps);
  const count = Number.isFinite(lines) ? Math.max(0, Math.floor(lines)) : 50;
  if (resolved.backend?.kind === "windows") {
    return resolved.tailFile(join(ctx.stateDir, COLLIE_LOG_FILE), count);
  }
  if (resolved.backend?.logsCmd !== undefined) {
    return await resolved.backend.logsCmd(count);
  }
  return resolved.tailFile(join(ctx.stateDir, COLLIE_LOG_FILE), count);
}

export async function qr(ctx: CtlCtx, deps: InfoDeps = {}): Promise<string> {
  const resolved = resolveDeps(deps);
  const target = resolved.publicUrl ?? (await url(ctx, deps));
  return await resolved.renderQr(target);
}

export async function version(deps: InfoDeps = {}): Promise<string> {
  const resolved = resolveDeps(deps);
  const parsed: unknown = JSON.parse(await resolved.readPackageJson());
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("package.json does not contain a version string");
  }
  const versionValue = (parsed as { version?: unknown }).version;
  if (typeof versionValue !== "string" || versionValue.trim().length === 0) {
    throw new Error("package.json does not contain a version string");
  }
  return versionValue.trim();
}

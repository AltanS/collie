import { readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { Ctx, ServiceBackend, ShellResult } from "./types.ts";

/** The supervisor methods lifecycle verbs need; log/status methods are deliberately not coupled in. */
export interface LifecycleBackend
  extends Pick<ServiceBackend, "install" | "start" | "stop"> {
  /** Remove the supervisor registration, when the selected backend supports teardown. */
  uninstall?: (ctx: Ctx) => Promise<void>;
}

/** The injected operational seams exported by verbs-ops.ts. */
export interface LifecycleOps {
  /** Build unconditionally, as used by update. */
  build?: (ctx: Ctx) => Promise<void>;
  /** Optional explicit rebuild alias for callers that distinguish build from rebuild. */
  rebuild?: (ctx: Ctx) => Promise<void>;
  /** Optional first-run build operation. */
  ensureBuild?: (ctx: Ctx) => Promise<void>;
  /** Compatibility spelling for callers porting the shell verb literally. */
  ensure_build?: (ctx: Ctx) => Promise<void>;
  /** Remove only Collie's recorded Tailscale mapping. */
  unserve?: (ctx: Ctx) => Promise<void>;
}

/** Readiness options used by the default loopback TCP probe. */
export interface ReadinessOptions {
  host?: string;
  attempts?: number;
  intervalMs?: number;
}

/** A readiness seam; tests subscribe to this exact state instead of sleeping. */
export type ReadinessWaiter = (
  port: number,
  options?: ReadinessOptions,
) => Promise<boolean>;

/** A command seam for real Git fixture tests and command-level unit tests. */
export type LifecycleExecutor = (
  argv: string[],
  options?: { cwd?: string },
) => Promise<ShellResult>;

/** A Git seam whose arguments exclude the executable and whose cwd is explicit. */
export type GitRunner = (
  args: readonly string[],
  options: { cwd: string },
) => Promise<ShellResult>;

/** A URL provider used by start after the bridge has become ready. */
export type UrlProvider = (ctx: Ctx) => string | Promise<string>;

/** Dependencies for lifecycle verbs. */
export interface LifecycleDeps {
  backend: LifecycleBackend;
  ops?: LifecycleOps;
  /** Flat aliases are accepted for callers that inject the verbs-ops exports directly. */
  build?: LifecycleOps["build"];
  rebuild?: LifecycleOps["rebuild"];
  ensureBuild?: LifecycleOps["ensureBuild"];
  ensure_build?: LifecycleOps["ensure_build"];
  unserve?: LifecycleOps["unserve"];
  rootDir?: string;
  env?: Record<string, string | undefined>;
  port?: number;
  waitForReadiness?: ReadinessWaiter;
  readinessOptions?: ReadinessOptions;
  executor?: LifecycleExecutor;
  git?: GitRunner;
  exists?: (path: string) => Promise<boolean>;
  readText?: (path: string) => Promise<string>;
  distIndex?: string;
  publicUrl?: string;
  url?: string | UrlProvider;
  getUrl?: UrlProvider;
  printUrl?: (ctx: Ctx) => void | string | Promise<void | string>;
  removeRegistration?: (ctx: Ctx) => Promise<void>;
}

/** The command failure exposed by lifecycle operations, retaining the original Git argv. */
export class LifecycleCommandError extends Error {
  readonly argv: string[];
  readonly result: ShellResult;

  constructor(argv: string[], result: ShellResult) {
    const detail = result.stderr.trim() || result.stdout.trim();
    super(`command failed (${result.exitCode}): ${argv.join(" ")}${detail ? `\n${detail}` : ""}`);
    this.name = "LifecycleCommandError";
    this.argv = argv;
    this.result = result;
  }

  get exitCode(): number {
    return this.result.exitCode;
  }
}

const DEFAULT_PORT = 8787;
const DEFAULT_ROOT = resolve(import.meta.dir, "../..");
const PIDFILE = "collie.pid";
const DIST_INDEX = join("web", "dist", "index.html");
const SERVE_MAPPING = "tailscale-managed-handler";
const MAJOR_ACTION = "herdr plugin action invoke update-major --plugin herdr.collie";

interface LifecycleEnvironment {
  [key: string]: string | undefined;
}

interface ReleaseTag {
  name: string;
  version: string;
  commit: string;
  major: number;
  minor: number;
  patch: number;
  peeled: boolean;
}

interface UpdateInvocation {
  deps: LifecycleDeps;
  args: readonly string[];
}

type LifecycleInput = LifecycleDeps | LifecycleBackend;

function isDeps(value: LifecycleInput): value is LifecycleDeps {
  return Object.prototype.hasOwnProperty.call(value, "backend");
}

function normalizeDeps(deps: LifecycleDeps): LifecycleDeps {
  const direct: LifecycleOps = {
    build: deps.build,
    rebuild: deps.rebuild,
    ensureBuild: deps.ensureBuild,
    ensure_build: deps.ensure_build,
    unserve: deps.unserve,
  };
  const hasDirect = Object.values(direct).some((operation) => operation !== undefined);
  if (!hasDirect) return deps;
  return { ...deps, ops: { ...direct, ...(deps.ops ?? {}) } };
}

function resolveDeps(input: LifecycleInput, ops?: LifecycleOps): LifecycleDeps {
  if (isDeps(input)) return normalizeDeps(input);
  return { backend: input, ...(ops === undefined ? {} : { ops }) };
}

function rootDir(ctx: Ctx, deps: LifecycleDeps): string {
  return deps.rootDir ?? ctx.rootDir ?? DEFAULT_ROOT;
}

function operationContext(ctx: Ctx, deps: LifecycleDeps): Ctx {
  const root = rootDir(ctx, deps);
  const env = {
    ...(ctx.env ?? {}),
    ...(deps.env ?? {}),
  };
  return { ...ctx, rootDir: root, env };
}

function parseDotEnvLine(line: string): [string, string] | undefined {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return undefined;
  const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
  if (!match) return undefined;
  let value = match[2] ?? "";
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  return [match[1]!, value];
}

async function readConfigEnvironment(
  ctx: Ctx,
  deps: LifecycleDeps,
): Promise<LifecycleEnvironment> {
  const environment: LifecycleEnvironment = { ...process.env };
  try {
    const readConfig = deps.readText ?? ((path: string) => readFile(path, "utf8"));
    const text = await readConfig(join(ctx.configDir, ".env"));
    for (const line of text.split(/\r?\n/)) {
      const parsed = parseDotEnvLine(line);
      if (parsed) environment[parsed[0]] = parsed[1];
    }
  } catch {
    // .env is optional on a first install; build/exec operations report their own missing config.
  }
  Object.assign(environment, ctx.env ?? {}, deps.env ?? {});
  return environment;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) return DEFAULT_PORT;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PORT;
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function exists(path: string, deps: LifecycleDeps): Promise<boolean> {
  return await (deps.exists ?? defaultExists)(path);
}

async function defaultReadText(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

async function execute(
  ctx: Ctx,
  deps: LifecycleDeps,
  argv: string[],
  cwd: string,
): Promise<ShellResult> {
  if (deps.executor) return await deps.executor(argv, { cwd });
  if (ctx.shell) {
    const command = argv[0];
    if (command === undefined) throw new Error("ctl cannot execute an empty command");
    return await ctx.shell(command, argv.slice(1), { cwd });
  }
  const child = Bun.spawn(argv, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const exitCode = await child.exited;
  return { stdout: await stdout, stderr: await stderr, exitCode };
}

async function runGit(
  ctx: Ctx,
  deps: LifecycleDeps,
  root: string,
  args: readonly string[],
): Promise<ShellResult> {
  if (deps.git) return await deps.git(args, { cwd: root });
  return await execute(ctx, deps, ["git", "-C", root, ...args], root);
}

async function checkedGit(
  ctx: Ctx,
  deps: LifecycleDeps,
  root: string,
  args: readonly string[],
): Promise<ShellResult> {
  const result = await runGit(ctx, deps, root, args);
  if (result.exitCode !== 0) {
    throw new LifecycleCommandError(["git", "-C", root, ...args], result);
  }
  return result;
}

async function defaultReadiness(
  port: number,
  options: ReadinessOptions = {},
): Promise<boolean> {
  const host = options.host ?? "127.0.0.1";
  const attempts = Math.max(1, Math.floor(options.attempts ?? 25));
  const intervalMs = Math.max(0, Math.floor(options.intervalMs ?? 200));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const socket = await Bun.connect({
        hostname: host,
        port,
        socket: {
          open() {},
          data() {},
          error() {},
          close() {},
        },
      });
      socket.end();
      return true;
    } catch {
      if (attempt + 1 < attempts && intervalMs > 0) await Bun.sleep(intervalMs);
    }
  }
  return false;
}

async function ensureBuildInternal(ctx: Ctx, deps: LifecycleDeps): Promise<void> {
  const operation = operationContext(ctx, deps);
  const operations = deps.ops;
  const explicit = operations?.ensureBuild ?? operations?.ensure_build;
  if (explicit) {
    await explicit(operation);
    return;
  }

  const root = rootDir(ctx, deps);
  const distIndex = deps.distIndex ?? join(root, DIST_INDEX);
  if (await exists(distIndex, deps)) return;

  if (operations?.build) {
    await operations.build(operation);
    return;
  }
  throw new Error("ctl start requires an injected build or ensureBuild operation");
}

/** Ensure the first-run UI build exists, using only the injected verbs-ops seam. */
export async function ensureBuild(
  ctx: Ctx,
  input: LifecycleInput,
  ops?: LifecycleOps,
): Promise<void> {
  await ensureBuildInternal(ctx, resolveDeps(input, ops));
}

function parseServeUrl(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (line === undefined) return undefined;
  const fields = line.split("|");
  if (fields.length !== 3) return undefined;
  const modePort = fields[0] ?? "";
  const hostPort = fields[1] ?? "";
  const match = /^(http|https):(\d+)$/.exec(modePort);
  if (!match || hostPort === "") return undefined;
  const mode = match[1];
  const port = match[2];
  if (mode === "https" && port === "443") {
    return `https://${hostPort.replace(/:443$/, "")}`;
  }
  return `${mode}://${hostPort}`;
}

async function resolveUrl(
  ctx: Ctx,
  deps: LifecycleDeps,
  environment: LifecycleEnvironment,
  port: number,
): Promise<string> {
  const provider = deps.getUrl ?? (typeof deps.url === "function" ? deps.url : undefined);
  if (provider) {
    const provided = (await provider(operationContext(ctx, deps))).trim();
    if (provided !== "") return provided;
  }
  const configured =
    (typeof deps.url === "string" ? deps.url : undefined) ??
    deps.publicUrl ??
    environment.COLLIE_PUBLIC_URL;
  if (configured?.trim()) return configured.trim();

  try {
    const mapping = await (deps.readText ?? defaultReadText)(
      join(ctx.configDir, SERVE_MAPPING),
    );
    const mapped = parseServeUrl(mapping);
    if (mapped) return mapped;
  } catch {
    // A separate `serve` verb may not have published a mapping yet.
  }
  return `http://127.0.0.1:${port}`;
}

async function waitUntilReady(
  deps: LifecycleDeps,
  port: number,
): Promise<boolean> {
  return await (deps.waitForReadiness ?? defaultReadiness)(port, deps.readinessOptions);
}

async function printReadyUrl(
  ctx: Ctx,
  deps: LifecycleDeps,
  environment: LifecycleEnvironment,
  port: number,
): Promise<void> {
  if (deps.printUrl) {
    const printed = await deps.printUrl(operationContext(ctx, deps));
    if (typeof printed === "string" && printed.trim() !== "") ctx.log(`open: ${printed.trim()}`);
    return;
  }
  ctx.log(`open: ${await resolveUrl(ctx, deps, environment, port)}`);
}

/** Start the bridge: first-run build, service registration, service start, readiness, and URL. */
export function start(
  ctx: Ctx,
  deps: LifecycleDeps,
): Promise<void>;
export function start(
  ctx: Ctx,
  backend: LifecycleBackend,
  ops?: LifecycleOps,
): Promise<void>;
export async function start(
  ctx: Ctx,
  input: LifecycleInput,
  ops?: LifecycleOps,
): Promise<void> {
  const deps = resolveDeps(input, ops);
  const environment = await readConfigEnvironment(ctx, deps);
  const port = deps.port ?? parsePort(environment.COLLIE_PORT);
  await ensureBuildInternal(ctx, deps);
  await deps.backend.install(ctx);
  await deps.backend.start(ctx);
  if (!(await waitUntilReady(deps, port))) {
    throw new Error(`bridge did not become ready on 127.0.0.1:${port}`);
  }
  await printReadyUrl(ctx, deps, environment, port);
}

/** Stop the installed service without removing its registration. */
export function stop(ctx: Ctx, deps: LifecycleDeps): Promise<void>;
export function stop(
  ctx: Ctx,
  backend: LifecycleBackend,
  ops?: LifecycleOps,
): Promise<void>;
export async function stop(
  ctx: Ctx,
  input: LifecycleInput,
  ops?: LifecycleOps,
): Promise<void> {
  const deps = resolveDeps(input, ops);
  await deps.backend.stop(ctx);
}

async function restartService(ctx: Ctx, deps: LifecycleDeps): Promise<void> {
  await deps.backend.stop(ctx);
  await deps.backend.start(ctx);
}

/** Restart by delegating the stop/start pair to the selected supervisor backend. */
export function restart(ctx: Ctx, deps: LifecycleDeps): Promise<void>;
export function restart(
  ctx: Ctx,
  backend: LifecycleBackend,
  ops?: LifecycleOps,
): Promise<void>;
export async function restart(
  ctx: Ctx,
  input: LifecycleInput,
  ops?: LifecycleOps,
): Promise<void> {
  await restartService(ctx, resolveDeps(input, ops));
}

async function removeRegistration(ctx: Ctx, deps: LifecycleDeps): Promise<void> {
  if (deps.removeRegistration) {
    await deps.removeRegistration(ctx);
    return;
  }
  if (deps.backend.uninstall) await deps.backend.uninstall(ctx);
}

/**
 * Tear down only resources Collie owns. The config `.env` and checkout are intentionally untouched.
 */
export function uninstall(ctx: Ctx, deps: LifecycleDeps): Promise<void>;
export function uninstall(
  ctx: Ctx,
  backend: LifecycleBackend,
  ops?: LifecycleOps,
): Promise<void>;
export async function uninstall(
  ctx: Ctx,
  input: LifecycleInput,
  ops?: LifecycleOps,
): Promise<void> {
  const deps = resolveDeps(input, ops);
  await deps.backend.stop(ctx);
  if (deps.ops?.unserve) await deps.ops.unserve(operationContext(ctx, deps));
  await removeRegistration(ctx, deps);
  await rm(join(ctx.configDir, PIDFILE), { force: true });
  ctx.log("uninstalled: service registration and Collie's managed serve mapping removed");
}

function parseUpdateInvocation(
  input: LifecycleDeps | readonly string[],
  other?: LifecycleDeps | readonly string[],
): UpdateInvocation {
  if (Array.isArray(input)) {
    if (other === undefined || Array.isArray(other)) {
      throw new Error("ctl update requires lifecycle dependencies");
    }
    return { deps: other as LifecycleDeps, args: input };
  }
  return {
    deps: input as LifecycleDeps,
    args: other === undefined || Array.isArray(other) ? other ?? [] : [],
  };
}

function wantsMajor(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--major");
}

function manifestVersion(text: string): string | undefined {
  const match = /^\s*version\s*=\s*"([^"]+)"\s*$/m.exec(text);
  return match?.[1];
}

async function installedVersion(deps: LifecycleDeps, root: string): Promise<string> {
  try {
    const text = await (deps.readText ?? defaultReadText)(join(root, "herdr-plugin.toml"));
    return manifestVersion(text) ?? "";
  } catch {
    return "";
  }
}

function versionParts(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function majorOf(version: string): number | undefined {
  const parts = versionParts(version);
  return parts?.[0];
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! > b[index]! ? 1 : -1;
  }
  return 0;
}

function parseReleaseTags(text: string): ReleaseTag[] {
  const tags = new Map<string, ReleaseTag>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]+)\s+refs\/tags\/(v\d+\.\d+\.\d+)(\^\{\})?$/.exec(
      line.trim(),
    );
    if (!match) continue;
    const version = match[2]!.slice(1);
    const parts = versionParts(version);
    if (!parts) continue;
    const peeled = match[3] !== undefined;
    const current: ReleaseTag = {
      name: match[2]!,
      version,
      commit: match[1]!,
      major: parts[0],
      minor: parts[1],
      patch: parts[2],
      peeled,
    };
    const previous = tags.get(current.name);
    if (previous === undefined || peeled || !previous.peeled) tags.set(current.name, current);
  }
  return [...tags.values()].sort((left, right) => {
    if (left.major !== right.major) return left.major - right.major;
    if (left.minor !== right.minor) return left.minor - right.minor;
    return left.patch - right.patch;
  });
}

function highestTag(tags: readonly ReleaseTag[], major: number): ReleaseTag | undefined {
  return [...tags].reverse().find((tag) => tag.major === major);
}

function nextMajorTag(tags: readonly ReleaseTag[], major: number): ReleaseTag | undefined {
  const next = tags.find((tag) => tag.major > major)?.major;
  return next === undefined ? undefined : highestTag(tags, next);
}

function announceMajor(ctx: Ctx, tag: ReleaseTag | undefined): void {
  if (!tag) return;
  ctx.log(`note: Collie ${tag.version} is out - a NEW MAJOR, which a routine update never takes.`);
  ctx.log(`      Read its release notes, then consent to it with: ${MAJOR_ACTION}`);
}

async function currentHead(
  ctx: Ctx,
  deps: LifecycleDeps,
  root: string,
): Promise<string> {
  return (await checkedGit(ctx, deps, root, ["rev-parse", "HEAD"])).stdout.trim();
}

async function isShallow(
  ctx: Ctx,
  deps: LifecycleDeps,
  root: string,
): Promise<boolean> {
  return (
    (await checkedGit(ctx, deps, root, ["rev-parse", "--is-shallow-repository"])).stdout.trim() ===
    "true"
  );
}

async function detachOnto(
  ctx: Ctx,
  deps: LifecycleDeps,
  root: string,
  ref: string,
): Promise<boolean> {
  const before = await currentHead(ctx, deps, root);
  const fetchArgs = ["fetch"];
  if (await isShallow(ctx, deps, root)) fetchArgs.push("--depth", "1");
  fetchArgs.push("origin", ref);
  await checkedGit(ctx, deps, root, fetchArgs);
  await checkedGit(ctx, deps, root, ["checkout", "-q", "--detach", "--force", "FETCH_HEAD"]);
  const after = await currentHead(ctx, deps, root);
  ctx.log(`updated detached checkout to ${after.slice(0, 12)}`);
  return before !== after;
}

async function manifestAtRef(
  ctx: Ctx,
  deps: LifecycleDeps,
  root: string,
  ref: string,
): Promise<string> {
  const result = await runGit(ctx, deps, root, ["show", `${ref}:herdr-plugin.toml`]);
  return result.exitCode === 0 ? manifestVersion(result.stdout) ?? "" : "";
}

async function updateLinked(
  ctx: Ctx,
  deps: LifecycleDeps,
  root: string,
  installed: string,
  args: readonly string[],
): Promise<boolean> {
  const before = await currentHead(ctx, deps, root);
  await checkedGit(ctx, deps, root, ["fetch", "origin"]);
  const upstream = await runGit(ctx, deps, root, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);
  const ref = upstream.exitCode === 0 ? upstream.stdout.trim() : "";
  if (ref && !wantsMajor(args)) {
    const targetVersion = await manifestAtRef(ctx, deps, root, ref);
    const installedMajor = majorOf(installed);
    const targetMajor = majorOf(targetVersion);
    if (
      installedMajor !== undefined &&
      targetMajor !== undefined &&
      targetMajor > installedMajor
    ) {
      ctx.log(`refusing to update: ${installed} -> ${targetVersion} (${ref}) crosses a MAJOR version.`);
      ctx.log(`      Consent explicitly with: ${MAJOR_ACTION} (or pass --major directly)`);
      ctx.log("      (nothing was pulled - this checkout is unchanged)");
      return false;
    }
  }
  ctx.log("updating linked checkout (git pull --ff-only)...");
  await checkedGit(ctx, deps, root, ["pull", "--ff-only"]);
  const after = await currentHead(ctx, deps, root);
  return before !== after;
}

async function updateDetached(
  ctx: Ctx,
  deps: LifecycleDeps,
  root: string,
  installed: string,
  args: readonly string[],
): Promise<boolean> {
  const installedMajor = majorOf(installed);
  if (installedMajor === undefined) {
    ctx.log("updating detached checkout (no readable version - following origin HEAD)...");
    return await detachOnto(ctx, deps, root, "HEAD");
  }

  const tagsResult = await runGit(ctx, deps, root, ["ls-remote", "--tags", "origin"]);
  if (tagsResult.exitCode !== 0) {
    throw new LifecycleCommandError(
      ["git", "-C", root, "ls-remote", "--tags", "origin"],
      tagsResult,
    );
  }
  const tags = parseReleaseTags(tagsResult.stdout);
  // Older/local repositories may have no release tags at all. Preserve ADR 0006's original
  // fetch-and-detach behavior in that case; once strict release tags exist, ADR 0020 governs.
  if (tags.length === 0) {
    ctx.log("updating detached checkout (no release tags - following origin HEAD)...");
    return await detachOnto(ctx, deps, root, "HEAD");
  }

  const nextMajor = nextMajorTag(tags, installedMajor);
  const target = wantsMajor(args)
    ? nextMajor
    : highestTag(tags, installedMajor);
  if (!target) {
    if (!wantsMajor(args)) announceMajor(ctx, nextMajor);
    return false;
  }

  const before = await currentHead(ctx, deps, root);
  if (target.commit === before || compareVersions(target.version, installed) <= 0) {
    ctx.log(`already current - v${target.version} is the newest release of major ${target.major}.`);
    if (!wantsMajor(args)) announceMajor(ctx, nextMajor);
    return false;
  }

  ctx.log(`updating detached checkout (fetch + detach onto ${target.name})...`);
  return await detachOnto(ctx, deps, root, `refs/tags/${target.name}`);
}

/** Advance a checkout according to ADR 0006 and the ADR 0020 major gate. */
export async function updateCheckout(
  ctx: Ctx,
  deps: LifecycleDeps,
  args: readonly string[] = [],
): Promise<boolean> {
  const root = rootDir(ctx, deps);
  const gitDir = await runGit(ctx, deps, root, ["rev-parse", "--git-dir"]);
  if (gitDir.exitCode !== 0) {
    throw new Error(`${root} is not a git checkout - reinstall with: herdr plugin install AltanS/collie --yes`);
  }
  const installed = await installedVersion(deps, root);
  const symbolicRef = await runGit(ctx, deps, root, ["symbolic-ref", "-q", "HEAD"]);
  if (symbolicRef.exitCode === 0) {
    return await updateLinked(ctx, deps, root, installed, args);
  }
  return await updateDetached(ctx, deps, root, installed, args);
}

/** Update the checkout, rebuild it, and restart the already-registered service. */
export function update(
  ctx: Ctx,
  deps: LifecycleDeps,
  args?: readonly string[],
): Promise<void>;
export function update(
  ctx: Ctx,
  args: readonly string[],
  deps: LifecycleDeps,
): Promise<void>;
export async function update(
  ctx: Ctx,
  input: LifecycleDeps | readonly string[],
  other?: LifecycleDeps | readonly string[],
): Promise<void> {
  const invocation = parseUpdateInvocation(input, other);
  const { deps, args } = invocation;
  if (!(await updateCheckout(ctx, deps, args))) return;
  const operation = operationContext(ctx, deps);
  const rebuild = deps.ops?.rebuild ?? deps.ops?.build;
  if (!rebuild) throw new Error("ctl update requires an injected build operation");
  await rebuild(operation);
  await restartService(ctx, deps);
  ctx.log("update complete");
}

export const ensure_build = ensureBuild;
export const cmdStart = start;
export const cmdStop = stop;
export const cmdRestart = restart;
export const cmdUninstall = uninstall;
export const cmdUpdate = update;
export const runStart = start;
export const runStop = stop;
export const runRestart = restart;
export const runUninstall = uninstall;
export const runUpdate = update;

export { parseReleaseTags };

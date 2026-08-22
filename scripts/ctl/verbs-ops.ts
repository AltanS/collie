import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * The part of the ctl context used by operational verbs.
 *
 * `shell` is intentionally structural here. Todo 5 owns the public ctl contracts, while this file
 * also needs to be useful in isolation for fixture tests. At runtime it accepts the shared
 * `shell(command, args, options)` function or an object exposing the same `run` shape.
 */
export interface OpsContext {
  configDir: string;
  stateDir: string;
  socketPath?: string;
  rootDir?: string;
  env?: Record<string, string | undefined>;
  log?: (...args: unknown[]) => void;
  shell?: unknown;
}

/** A completed child-process invocation. Non-zero statuses are never silently discarded. */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** The injectable process boundary used by tests and by the ctl shell contract. */
export type CommandExecutor = (
  argv: string[],
  options?: { cwd?: string; env?: Record<string, string> },
) => Promise<CommandResult>;

/** A process returned by an injected bridge spawner. */
export interface SpawnedProcess {
  exited: Promise<number>;
}

/** The subset of Bun.spawn options needed by exec-bridge. */
export interface BridgeSpawnOptions {
  cwd: string;
  env: Record<string, string>;
  stdout: unknown;
  stderr: unknown;
}

/** Injectable process creation for exec-bridge tests. */
export type ProcessSpawner = (
  argv: string[],
  options: BridgeSpawnOptions,
) => SpawnedProcess | Promise<SpawnedProcess> | number | Promise<number>;

/** A parsed line from tailscale-managed-handler. */
export interface ManagedServeMapping {
  mode: "http" | "https";
  port: number;
  handler: string;
  hostPort: string;
  proxy: string;
}

/** The result used when deciding whether a Tailscale root can be replaced. */
export type RootFingerprint = "absent" | "http|other" | "https|other" | "other|other" | `${"http" | "https"}|proxy:${string}`;

/** Common options for the operational verbs. */
export interface OpsOptions {
  executor?: CommandExecutor;
  rootDir?: string;
  env?: Record<string, string | undefined>;
  bun?: string;
  mappingFile?: string;
}

/** Build-specific paths and failure-injection hooks. */
export interface BuildOptions extends OpsOptions {
  webDir?: string;
  distDir?: string;
  stagingDir?: string;
  skipVersionCheck?: boolean;
  skipTypecheck?: boolean;
}

/** Injectable filesystem boundary for atomic directory-swap tests. */
export interface DistSwapFileOps {
  exists?: (path: string) => Promise<boolean>;
  rename?: (from: string, to: string) => Promise<void>;
  remove?: (path: string) => Promise<void>;
}

/** Serve-specific options. */
export interface ServeOptions extends OpsOptions {
  port?: number;
  mode?: "http" | "https";
}

/** Bridge launch options. */
export interface ExecBridgeOptions extends OpsOptions {
  spawner?: ProcessSpawner;
  logFile?: string;
}

/** An operational child failure with its original argv and captured output. */
export class CommandError extends Error {
  readonly argv: string[];
  readonly result: CommandResult;

  constructor(argv: string[], result: CommandResult) {
    const detail = result.stderr.trim() || result.stdout.trim();
    super(`command failed (${result.exitCode}): ${argv.join(" ")}${detail ? `\n${detail}` : ""}`);
    this.name = "CommandError";
    this.argv = argv;
    this.result = result;
  }

  get exitCode(): number {
    return this.result.exitCode;
  }
}

const MANAGED_HANDLER_FILE = "tailscale-managed-handler";
const DEFAULT_PORT = 8787;

function rootDir(ctx: OpsContext, options: OpsOptions = {}): string {
  return options.rootDir ?? ctx.rootDir ?? resolve(import.meta.dir, "../..");
}

function bunCommand(options: OpsOptions): string {
  return options.bun ?? process.env.BUN_BINARY ?? "bun";
}

function emitLog(ctx: OpsContext, ...args: unknown[]): void {
  ctx.log?.(...args);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return value === undefined || value === null ? "" : String(value);
}

function normalizeCommandResult(value: unknown): CommandResult {
  if (typeof value === "number") return { exitCode: value, stdout: "", stderr: "" };
  if (value === undefined || value === null) return { exitCode: 0, stdout: "", stderr: "" };
  const record = asRecord(value);
  if (!record) throw new Error("ctl shell returned an unsupported result");
  const status = record.exitCode ?? record.code ?? record.status ?? 0;
  if (typeof status !== "number") throw new Error("ctl shell returned a non-numeric exit code");
  return {
    exitCode: status,
    stdout: textValue(record.stdout),
    stderr: textValue(record.stderr),
  };
}

function shellExecutor(shell: unknown): CommandExecutor | undefined {
  const invoke = (candidate: unknown, receiver?: unknown): CommandExecutor | undefined => {
    if (typeof candidate !== "function") return undefined;
    return async (argv, options) => {
      const command = argv[0];
      if (command === undefined) throw new Error("ctl cannot execute an empty command");
      const args = argv.slice(1);
      const shellOptions = options?.cwd === undefined ? {} : { cwd: options.cwd };
      const fn = candidate as (
        command: string,
        args?: readonly string[],
        options?: { cwd?: string },
      ) => unknown;
      return normalizeCommandResult(await fn.call(receiver, command, args, shellOptions));
    };
  };
  return invoke(shell) ?? invoke(asRecord(shell)?.run, shell);
}

async function spawnAndCapture(
  argv: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<CommandResult> {
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = child.stdout ? new Response(child.stdout).text() : Promise.resolve("");
  const stderr = child.stderr ? new Response(child.stderr).text() : Promise.resolve("");
  const [exitCode, out, err] = await Promise.all([child.exited, stdout, stderr]);
  return { exitCode, stdout: out, stderr: err };
}

async function execute(
  ctx: OpsContext,
  argv: string[],
  options: OpsOptions = {},
  cwd: string = rootDir(ctx, options),
  env?: Record<string, string>,
): Promise<CommandResult> {
  const executor = options.executor ?? shellExecutor(ctx.shell);
  if (executor) return executor(argv, { cwd, env });
  return spawnAndCapture(argv, { cwd, env });
}

async function checked(
  ctx: OpsContext,
  argv: string[],
  options: OpsOptions,
  cwd: string,
  env?: Record<string, string>,
): Promise<CommandResult> {
  const result = await execute(ctx, argv, options, cwd, env);
  if (result.exitCode !== 0) throw new CommandError(argv, result);
  return result;
}

function envWithoutUndefined(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function parseDotEnvLine(line: string): [string, string] | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
  if (!match) return undefined;
  let value = match[2] ?? "";
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  return [match[1]!, value];
}

async function childEnv(ctx: OpsContext, options: OpsOptions = {}, overrides: Record<string, string> = {}): Promise<Record<string, string>> {
  const merged: Record<string, string | undefined> = { ...process.env, ...(ctx.env ?? {}), ...(options.env ?? {}) };
  try {
    const dotenv = await readFile(join(ctx.configDir, ".env"), "utf8");
    for (const line of dotenv.split(/\r?\n/)) {
      const parsed = parseDotEnvLine(line);
      if (parsed) merged[parsed[0]] = parsed[1];
    }
  } catch {
    // The .env is optional on first install. The wrapped script reports missing configuration itself.
  }
  Object.assign(merged, overrides);
  return envWithoutUndefined(merged);
}

function mappingPath(ctx: OpsContext, options: OpsOptions = {}): string {
  return options.mappingFile ?? join(ctx.configDir, MANAGED_HANDLER_FILE);
}

function parsePort(value: string | undefined, fallback = DEFAULT_PORT): number {
  if (value === undefined || !/^\d+$/.test(value)) return fallback;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

/** Serialize the ownership record used by both serve and unserve. */
export function serializeManagedMapping(mapping: ManagedServeMapping): string {
  return `${mapping.handler}|${mapping.hostPort}|${mapping.proxy}\n`;
}

/** Parse and validate an ownership record before it can authorize teardown. */
export function parseManagedMapping(text: string): ManagedServeMapping {
  const line = text.trim();
  const fields = line.split("|");
  if (fields.length !== 3) throw new Error(`invalid managed Tailscale handler state: ${line}`);
  const [handler, hostPort, proxy] = fields;
  let mode: "http" | "https";
  let port: number;
  if (handler?.startsWith("http:")) {
    mode = "http";
    port = parsePort(handler.slice("http:".length), 0);
    if (!port) throw new Error(`invalid managed Tailscale handler state: ${line}`);
  } else if (handler === "https:443") {
    mode = "https";
    port = 443;
  } else {
    throw new Error(`invalid managed Tailscale handler state: ${line}`);
  }
  if (!hostPort || !hostPort.endsWith(`:${port}`)) {
    throw new Error(`managed Tailscale HostPort does not match its listener: ${line}`);
  }
  if (!proxy || !/^http:\/\/127\.0\.0\.1:\d+$/.test(proxy)) {
    throw new Error(`invalid managed Tailscale proxy target: ${line}`);
  }
  const proxyPort = parsePort(proxy.slice("http://127.0.0.1:".length), 0);
  if (!proxyPort) throw new Error(`invalid managed Tailscale proxy target: ${line}`);
  return { mode, port, handler: handler!, hostPort: hostPort!, proxy: proxy! };
}

/** Read an ownership record, returning null when Collie has never published a mapping. */
export async function readManagedMapping(file: string): Promise<ManagedServeMapping | null> {
  try {
    return parseManagedMapping(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Write an ownership record without exposing a partially-written line to teardown. */
export async function writeManagedMapping(file: string, mapping: ManagedServeMapping): Promise<void> {
  await mkdir(resolve(file, ".."), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serializeManagedMapping(mapping), "utf8");
    try {
      await rename(temporary, file);
    } catch (error) {
      // Windows cannot rename over an existing file. Removing only our record is safe here: a new
      // mapping is not published until this write succeeds, and the caller owns this path by contract.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "EPERM") {
        throw error;
      }
      await rm(file, { force: true });
      await rename(temporary, file);
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Remove a record after teardown has proved that the recorded mapping is still Collie's. */
export async function removeManagedMapping(file: string): Promise<void> {
  await rm(file, { force: true });
}

function listenerProtocol(value: unknown): "http" | "https" | "other" {
  const listener = asRecord(value);
  if (listener?.HTTP === true) return "http";
  if (listener?.HTTPS === true) return "https";
  return "other";
}

function rootTargets(config: Record<string, unknown>, port: number): unknown[] {
  const web = asRecord(config.Web);
  if (!web) return [];
  return Object.entries(web)
    .filter(([hostPort]) => hostPort.endsWith(`:${port}`))
    .map(([, server]) => asRecord(asRecord(server)?.Handlers))
    .filter(
      (handlers): handlers is Record<string, unknown> =>
        handlers !== undefined && Object.prototype.hasOwnProperty.call(handlers, "/"),
    )
    .map((handlers) => asRecord(handlers["/"])?.Proxy);
}

function foregroundHasRoot(config: Record<string, unknown>, port: number): boolean {
  const foreground = asRecord(config.Foreground);
  if (!foreground) return false;
  return Object.values(foreground).some((value) => {
    const child = asRecord(value);
    return Boolean(child && (rootTargets(child, port).length > 0 || foregroundHasRoot(child, port)));
  });
}

/** Compute the exact root mapping that unserve is allowed to remove. */
export function tailscaleRootFingerprint(
  status: unknown,
  hostPort: string,
  port: number,
): RootFingerprint {
  const config = asRecord(status);
  if (!config) throw new Error("invalid Tailscale serve status");
  const web = asRecord(config.Web);
  const server = web ? asRecord(web[hostPort]) : undefined;
  const handlers = server ? asRecord(server.Handlers) : undefined;
  if (!handlers || !("/" in handlers)) return "absent";
  const protocol = listenerProtocol(asRecord(config.TCP)?.[String(port)]);
  const proxy = asRecord(handlers["/"])?.Proxy;
  return typeof proxy === "string" && proxy ? `${protocol}|proxy:${proxy}` as RootFingerprint : `${protocol}|other`;
}

/** Decide whether a root is free, adoptable, or occupied by somebody else. */
export function tailscaleRootAvailability(
  status: unknown,
  port: number,
  mode: "http" | "https",
  expectedProxy: string,
): "free" | "adoptable" | "occupied" | "protocol-mismatch" {
  const config = asRecord(status);
  if (!config) throw new Error("invalid Tailscale serve status");
  const desired = mode === "http" ? "http" : "https";
  const hasMismatch = (candidate: Record<string, unknown>): boolean => {
    const candidateListener = asRecord(candidate.TCP)?.[String(port)];
    return candidateListener !== undefined && listenerProtocol(candidateListener) !== desired;
  };
  const nestedMismatch = (candidate: Record<string, unknown>): boolean => {
    if (hasMismatch(candidate)) return true;
    const foreground = asRecord(candidate.Foreground);
    return Boolean(foreground && Object.values(foreground).some((value) => {
      const child = asRecord(value);
      return Boolean(child && nestedMismatch(child));
    }));
  };
  if (nestedMismatch(config)) return "protocol-mismatch";
  if (foregroundHasRoot(config, port)) return "occupied";
  const targets = rootTargets(config, port);
  if (targets.length === 0) return "free";
  return targets.every((target) => target === expectedProxy) ? "adoptable" : "occupied";
}

async function statusJson(ctx: OpsContext, options: OpsOptions, args: string[], cwd: string, env: Record<string, string>): Promise<Record<string, unknown>> {
  const result = await checked(ctx, ["tailscale", ...args], options, cwd, env);
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    const record = asRecord(parsed);
    if (!record) throw new Error("not an object");
    return record;
  } catch {
    throw new Error(`invalid Tailscale JSON from tailscale ${args.join(" ")}`);
  }
}

async function removeRecordedServe(ctx: OpsContext, options: OpsOptions, env: Record<string, string>): Promise<void> {
  const file = mappingPath(ctx, options);
  const mapping = await readManagedMapping(file);
  if (!mapping) {
    emitLog(ctx, "tailscale serve: no Collie-managed mapping recorded");
    return;
  }
  const cwd = rootDir(ctx, options);
  const status = await statusJson(ctx, options, ["serve", "status", "--json"], cwd, env);
  const fingerprint = tailscaleRootFingerprint(status, mapping.hostPort, mapping.port);
  if (fingerprint === "absent") {
    await removeManagedMapping(file);
    emitLog(ctx, "tailscale serve: managed root is already absent; cleared stale ownership state");
    return;
  }
  if (fingerprint !== `${mapping.mode}|proxy:${mapping.proxy}`) {
    throw new Error("managed Tailscale root was replaced; refusing to remove the current handler");
  }
  const args = mapping.mode === "http"
    ? ["serve", `--http=${mapping.port}`, "--set-path=/", "off"]
    : ["serve", "--https=443", "--set-path=/", "off"];
  const result = await execute(ctx, ["tailscale", ...args], options, cwd, env);
  if (result.exitCode !== 0 && !/handler does not exist/i.test(`${result.stdout}\n${result.stderr}`)) {
    throw new CommandError(["tailscale", ...args], result);
  }
  await removeManagedMapping(file);
  emitLog(ctx, `tailscale serve: removed Collie's managed ${mapping.handler} mapping`);
}

/**
 * Remove only the root mapping recorded by Collie. This deliberately never invokes `serve reset` and
 * refuses to remove a root whose current proxy no longer matches the ownership record.
 */
export async function unserve(ctx: OpsContext, options: OpsOptions = {}): Promise<void> {
  const env = await childEnv(ctx, options);
  await removeRecordedServe(ctx, options, env);
}

/** Publish Collie's one managed Tailscale root and record the exact mapping that was published. */
export async function serve(ctx: OpsContext, options: ServeOptions = {}): Promise<void> {
  const env = await childEnv(ctx, options);
  await removeRecordedServe(ctx, options, env);
  if (env.COLLIE_SKIP_SERVE === "1") {
    emitLog(ctx, "tailscale serve skipped (COLLIE_SKIP_SERVE=1)");
    return;
  }
  const port = options.port ?? parsePort(env.COLLIE_PORT);
  const mode = options.mode ?? (env.COLLIE_SERVE_MODE === "http" ? "http" : "https");
  const expectedProxy = `http://127.0.0.1:${port}`;
  const cwd = rootDir(ctx, options);
  const status = await statusJson(ctx, options, ["serve", "status", "--json"], cwd, env);
  const availability = tailscaleRootAvailability(status, mode === "http" ? port : 443, mode, expectedProxy);
  if (availability === "protocol-mismatch") {
    throw new Error(`Tailscale serve :${mode === "http" ? port : 443} already uses the opposite listener protocol`);
  }
  if (availability === "occupied") {
    throw new Error(`Tailscale serve already has an unowned root mount on :${mode === "http" ? port : 443}`);
  }
  const tailscaleStatus = await statusJson(ctx, options, ["status", "--json"], cwd, env);
  const self = asRecord(tailscaleStatus.Self);
  const dnsName = typeof self?.DNSName === "string" ? self.DNSName.replace(/\.+$/, "") : "";
  if (!dnsName) throw new Error("cannot determine Tailscale hostname; refusing to publish an untrackable root mount");
  const listenerPort = mode === "http" ? port : 443;
  const hostPort = `${dnsName}:${listenerPort}`;
  const mapping: ManagedServeMapping = {
    mode,
    port: listenerPort,
    handler: mode === "http" ? `http:${port}` : "https:443",
    hostPort,
    proxy: expectedProxy,
  };
  const args = mode === "http"
    ? ["serve", "--bg", `--http=${port}`, "--set-path=/", String(port)]
    : ["serve", "--bg", "--set-path=/", String(port)];
  const file = mappingPath(ctx, options);
  // Record before publication. If the process is interrupted after tailscale accepts the command, the
  // next unserve can still prove ownership and clean it up. A failed publication removes the record.
  await writeManagedMapping(file, mapping);
  const result = await execute(ctx, ["tailscale", ...args], options, cwd, env);
  await writeFile(join(ctx.configDir, "serve.out"), `${result.stdout}${result.stderr}`, "utf8").catch(() => undefined);
  if (result.exitCode !== 0) {
    await removeManagedMapping(file).catch(() => undefined);
    throw new CommandError(["tailscale", ...args], result);
  }
  emitLog(ctx, `tailscale serve (${mode}) -> tailnet :${listenerPort} -> ${expectedProxy}`);
}

/** Build the root and web trees into a staging directory, then transactionally replace web/dist. */
export async function build(ctx: OpsContext, options: BuildOptions = {}): Promise<void> {
  const root = rootDir(ctx, options);
  const web = options.webDir ?? join(root, "web");
  const dist = options.distDir ?? join(web, "dist");
  const staging = options.stagingDir ?? join(web, "dist-staging");
  const env = await childEnv(ctx, options);
  const bun = bunCommand(options);
  const skipVersionCheck = options.skipVersionCheck ?? env.SKIP_VERSION_CHECK === "1";
  const skipTypecheck = options.skipTypecheck ?? env.SKIP_TYPECHECK === "1";

  await rm(staging, { recursive: true, force: true });
  if (!skipVersionCheck) await checked(ctx, [bun, "scripts/check-version.ts"], options, root, env);
  await checked(ctx, [bun, "install"], options, root, env);
  if (!skipTypecheck) await checked(ctx, [bun, "run", "typecheck"], options, root, env);
  await checked(ctx, [bun, "install"], options, web, env);
  if (!skipTypecheck) await checked(ctx, [bun, "run", "typecheck"], options, web, env);
  await checked(
    ctx,
    [bun, "run", "build", "--", "--outDir", "dist-staging", "--emptyOutDir"],
    options,
    web,
    env,
  );
  await atomicSwapDist(staging, dist);
  emitLog(ctx, `built web UI -> ${dist}`);
}

/** Replace dist with staging without deleting the live tree until staging has succeeded. */
export async function atomicSwapDist(
  stagingDir: string,
  distDir: string,
  fileOps: DistSwapFileOps = {},
): Promise<void> {
  const exists = fileOps.exists ?? (async (path: string) => {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  });
  const move = fileOps.rename ?? (async (from: string, to: string) => {
    await rename(from, to);
  });
  const remove = fileOps.remove ?? (async (path: string) => {
    await rm(path, { recursive: true, force: true });
  });
  const hadDist = await exists(distDir);
  const backup = `${distDir}.backup-${process.pid}-${randomUUID()}`;
  let oldMoved = false;
  let newMoved = false;
  try {
    if (hadDist) {
      await move(distDir, backup);
      oldMoved = true;
    }
    await move(stagingDir, distDir);
    newMoved = true;
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    if (newMoved) {
      try {
        await remove(distDir);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (oldMoved) {
      try {
        await move(backup, distDir);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "atomic dist swap failed and rollback was incomplete");
    }
    throw error;
  }
  // A failed cleanup must not turn a successful swap into a reported failure: the new dist is live and
  // the old tree is still a safe backup. The next build uses a fresh, unique backup name.
  if (oldMoved) await remove(backup).catch(() => undefined);
}

/** Thin wrapper around scripts/push-keys.ts, using the same resolved config directory as the bridge. */
export async function pushKeys(ctx: OpsContext, args: readonly string[] = [], options: OpsOptions = {}): Promise<void> {
  await mkdir(ctx.configDir, { recursive: true });
  const root = rootDir(ctx, options);
  const env = await childEnv(ctx, options, { HERDR_PLUGIN_CONFIG_DIR: ctx.configDir });
  const argv = [bunCommand(options), "scripts/push-keys.ts", join(ctx.configDir, ".env"), ...args];
  await checked(ctx, argv, options, root, env);
}

/** Thin wrapper around scripts/push-test.ts, with the plugin .env loaded into the child environment. */
export async function pushTest(ctx: OpsContext, args: readonly string[] = [], options: OpsOptions = {}): Promise<void> {
  const root = rootDir(ctx, options);
  const env = await childEnv(ctx, options, { HERDR_PLUGIN_CONFIG_DIR: ctx.configDir });
  const envFile = join(ctx.configDir, ".env");
  const argv = [bunCommand(options)];
  try {
    await stat(envFile);
    argv.push(`--env-file=${envFile}`);
  } catch {
    // Keep the direct argv on first install; push-test reports the missing push configuration.
  }
  argv.push("scripts/push-test.ts", ...args);
  await checked(ctx, argv, options, root, env);
}

/**
 * Start the bridge process under the selected service supervisor. The service backend owns restart
 * policy; this verb owns the child argv, environment, and combined log redirection.
 */
export async function execBridge(ctx: OpsContext, options: ExecBridgeOptions = {}): Promise<void> {
  const root = rootDir(ctx, options);
  const logFile = options.logFile ?? join(ctx.stateDir, "collie.log");
  await mkdir(ctx.stateDir, { recursive: true });
  const env = await childEnv(ctx, options, {
    HERDR_PLUGIN_CONFIG_DIR: ctx.configDir,
    HERDR_PLUGIN_STATE_DIR: ctx.stateDir,
    ...(ctx.socketPath ? { HERDR_SOCKET_PATH: ctx.socketPath } : {}),
  });
  const argv = [bunCommand(options), "bridge/index.ts"];
  if (options.spawner) {
    const spawned = await options.spawner(argv, { cwd: root, env, stdout: logFile, stderr: logFile });
    const exitCode = typeof spawned === "number" ? spawned : await spawned.exited;
    if (exitCode !== 0) throw new CommandError(argv, { exitCode, stdout: "", stderr: "" });
    return;
  }
  const child = Bun.spawn(argv, {
    cwd: root,
    env,
    stdout: Bun.file(logFile),
    stderr: Bun.file(logFile),
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new CommandError(argv, { exitCode, stdout: "", stderr: "" });
}

// Verb aliases make the module convenient for main.ts dispatch while retaining descriptive names for
// direct callers and tests.
export const cmdBuild = build;
export const cmdServe = serve;
export const cmdUnserve = unserve;
export const cmdPushKeys = pushKeys;
export const cmdPushTest = pushTest;
export const cmdExecBridge = execBridge;
export const runBuild = build;
export const runServe = serve;
export const runUnserve = unserve;
export const runPushKeys = pushKeys;
export const runPushTest = pushTest;
export const runExecBridge = execBridge;

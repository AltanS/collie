import type { CliContext, ServeMode } from "./context.ts";
import { instanceSuffix } from "./context.ts";
import { EXIT, type Io } from "./io.ts";
import type { Exec, Files } from "./sys.ts";
import { tailnetName } from "./tailnet.ts";

// The single managed front door, ported from the pre-shim `collie-ctl.sh`. ADR 0001 is the whole
// point of this module: Collie manages exactly ONE `tailscale serve` mapping, records it, and only
// ever tears down a mapping still matching that record. The failure mode a bug here produces is not
// a broken Collie — it is a stranger's service silently unpublished.
//
// Two refusal directions, both preserved verbatim:
//   publishing  — a root mount we don't own is never overwritten ({@link rootAvailability});
//   teardown    — a root that no longer matches the record is never removed ({@link fingerprintRoot}).
//
// The JSON reasoning used to be two `bun -e` heredocs inside the shell, communicating through
// `process.env` and a stdout token. Here it is ordinary TypeScript over a parsed status object, so
// every verdict is a unit test with fixture JSON. `tailscale` itself is still shelled out to.

export interface ServeDeps {
  ctx: CliContext;
  io: Io;
  exec: Exec;
  files: Files;
}

// ── The ownership record ─────────────────────────────────────────────────────
// One line in the config dir: `<mode>:<port>|<HostPort>|<proxy>`, e.g.
// `https:443|host.ts.net:443|http://127.0.0.1:8787`. The format is NOT versioned, moved or
// migrated — a host upgrading from the shell to the binary must find its existing record valid.

export interface OwnershipRecord {
  mode: ServeMode;
  /** The listener port: `443` in https mode, the bridge port in http mode. */
  port: number;
  /** `<tailnet host>:<listener port>`. */
  hostPort: string;
  /** Always `http://127.0.0.1:<bridge port>`. */
  proxy: string;
}

/** The single line as it is written to disk (with its trailing newline). */
export function formatRecord(record: OwnershipRecord): string {
  return `${record.mode}:${record.port}|${record.hostPort}|${record.proxy}\n`;
}

/**
 * Parsing is defensive and every failure is fatal-with-retention: a record we cannot read is a
 * mapping we cannot prove we own, and removing it on a guess is the incident this whole module
 * exists to prevent. Throws with the shell's message; the caller prints it and keeps the file.
 */
export function parseRecord(raw: string): OwnershipRecord {
  const state = raw.replace(/\n+$/, "");
  // `IFS='|' read -r handler hostPort proxy extra` — a FOURTH field is an error, and everything
  // past it lands in `extra` too, so any over-long record is refused rather than truncated.
  const [handler = "", hostPort = "", proxy = "", ...rest] = state.split("|");
  const extra = rest.join("|");
  const mode = readMode(handler);
  if (mode === null || hostPort === "" || proxy === "" || extra !== "") {
    throw new Error(`invalid managed Tailscale handler state: ${state}`);
  }
  if (!hostPort.endsWith(`:${mode.port}`)) {
    throw new Error(`managed Tailscale HostPort does not match its listener: ${state}`);
  }
  // The shell's glob was `http://127.0.0.1:[0-9]*` — a loopback target followed by at least one
  // digit. Kept as-is: this rejects a non-loopback target, which is what it is for.
  if (!/^http:\/\/127\.0\.0\.1:[0-9]/.test(proxy)) {
    throw new Error(`invalid managed Tailscale proxy target: ${state}`);
  }
  return { mode: mode.mode, port: mode.port, hostPort, proxy };
}

/** `http:<digits>` or exactly `https:443` — nothing else is a handler we wrote. */
function readMode(handler: string): { mode: ServeMode; port: number } | null {
  if (handler === "https:443") return { mode: "https", port: 443 };
  const http = /^http:(\d+)$/.exec(handler);
  return http === null ? null : { mode: "http", port: Number(http[1]) };
}

/** How the record names its handler in operator-facing output (`http:8787`, `https:443`). */
export function handlerName(record: OwnershipRecord): string {
  return `${record.mode}:${record.port}`;
}

// ── `tailscale serve status --json` ──────────────────────────────────────────

/** One mount point's handler, keyed by mount path (`/`, `/api`, …) in {@link ServeHandlers}. */
export interface ServeHandlers {
  [mount: string]: { Proxy?: string } | undefined;
}

export interface ServeStatus {
  TCP?: Record<string, { HTTP?: boolean; HTTPS?: boolean } | undefined>;
  Web?: Record<string, { Handlers?: ServeHandlers } | undefined>;
  /** Foreground serve sessions nest arbitrarily deep, each a serve config in its own right. */
  Foreground?: Record<string, ServeStatus>;
}

/**
 * A malformed status is a REFUSAL, not a fallthrough. The shell's sub-process set
 * `process.exitCode = 2` and the caller refused; here the parse throws and the caller refuses with
 * the same message. Empty output parses as `{}`, exactly as `JSON.parse(data || "{}")` did.
 */
export function parseServeStatus(text: string): ServeStatus {
  // SAFETY: the shape `tailscale serve status --json` documents. Every field is optional and every
  // read below goes through `?.` with a fallback, so a status that disagrees fingerprints as
  // `absent`/`other` — a refusal — rather than being trusted.
  return JSON.parse(text.trim() === "" ? "{}" : text) as ServeStatus;
}

const hasRoot = (handlers: ServeHandlers): boolean => Object.prototype.hasOwnProperty.call(handlers, "/");

/**
 * What currently owns the root mount we recorded: `absent`, or `<protocol>|proxy:<target>`. This is
 * the evidence teardown checks before removing anything (the pre-shim `collie-ctl.sh`).
 */
export function fingerprintRoot(status: ServeStatus, hostPort: string, port: number): string {
  const handlers = status.Web?.[hostPort]?.Handlers ?? {};
  if (!hasRoot(handlers)) return "absent";
  const listener = status.TCP?.[String(port)];
  const protocol =
    listener?.HTTP === true ? "http" : listener?.HTTPS === true ? "https" : "other";
  const proxy = handlers["/"]?.Proxy;
  return proxy !== undefined && proxy.length > 0
    ? `${protocol}|proxy:${proxy}`
    : `${protocol}|other`;
}

export type Availability = "free" | "adoptable" | "occupied" | "protocol-mismatch";

/**
 * May we publish a root mount on `port`? `tailscale serve --bg … /` silently REPLACES an existing
 * root handler, so without this a Collie start could unpublish an unrelated service that got there
 * first (the pre-shim `collie-ctl.sh`).
 *
 * "Don't own" is decided by where the mount points, not by our ownership file: every install
 * predating ownership tracking has Collie's own root mount and NO record of it, so a pure file
 * check would refuse to republish on exactly the deployments that already work — bricking
 * start/restart/update on upgrade. A root already proxying to our own `http://127.0.0.1:$PORT` is
 * therefore `adoptable`, and we record it afterwards.
 *
 * A FOREGROUND session is never adoptable at any nesting depth: it belongs to a live process that
 * is not us, and its target matching ours proves nothing about who will tear it down.
 */
export function rootAvailability(
  status: ServeStatus,
  port: number,
  protocol: ServeMode,
  expectedProxy: string,
): Availability {
  const key = String(port);

  // Proxy targets of every root handler bound to our port, in ONE serve config level.
  const rootTargets = (config: ServeStatus): (string | undefined)[] =>
    Object.entries(config.Web ?? {})
      .filter(([hostPort]) => /:(\d+)$/.exec(hostPort)?.[1] === key)
      .map(([, server]) => server?.Handlers ?? {})
      .filter((handlers) => hasRoot(handlers))
      .map((handlers) => handlers["/"]?.Proxy);

  const foregroundTargets = (config: ServeStatus): (string | undefined)[] =>
    Object.values(config.Foreground ?? {}).flatMap((fg) =>
      rootTargets(fg).concat(foregroundTargets(fg)),
    );

  const hasProtocolMismatch = (config: ServeStatus): boolean => {
    const listener = config.TCP?.[key];
    const mismatch =
      listener !== undefined && (protocol === "http" ? listener.HTTP !== true : listener.HTTPS !== true);
    return mismatch || Object.values(config.Foreground ?? {}).some(hasProtocolMismatch);
  };

  if (hasProtocolMismatch(status)) return "protocol-mismatch";
  if (foregroundTargets(status).length > 0) return "occupied";
  const targets = rootTargets(status);
  if (targets.length === 0) return "free";
  return targets.every((target) => target === expectedProxy) ? "adoptable" : "occupied";
}

// ── Teardown ─────────────────────────────────────────────────────────────────

/**
 * `tailscale serve … off` for ONE handler, scoped to the listener and the root path — never a
 * blanket reset, and never an unscoped shutdown of :443 that could take down a mapping someone else
 * put there. "Already gone" is success so teardown is idempotent; any other failure is real.
 */
function removeHandler(deps: ServeDeps, record: OwnershipRecord): boolean {
  const listener = record.mode === "http" ? `--http=${record.port}` : "--https=443";
  const r = deps.exec.capture("tailscale", ["serve", listener, "--set-path=/", "off"]);
  if (r.found && r.code === 0) return true;
  const output = `${r.stdout}${r.stderr}`;
  if (output.includes("handler does not exist")) return true;
  if (output.trim() !== "") deps.io.err(output.trimEnd());
  const description =
    record.mode === "http" ? `HTTP :${record.port} root mount` : "HTTPS :443 root mount";
  deps.io.err(`error: failed to remove Collie's ${description} mapping`);
  return false;
}

/**
 * Remove ONLY the mapping Collie recorded as its own. No record at all is success — there is
 * nothing of ours out there. Every other failure KEEPS the record: dropping it would orphan a live
 * mapping with nothing left that knows Collie owns it.
 */
export function stopTailscaleServe(deps: ServeDeps): number {
  const raw = deps.files.read(deps.ctx.handlerFile);
  if (raw === null) {
    deps.io.out("tailscale serve: no Collie-managed mapping recorded");
    return EXIT.OK;
  }

  let record: OwnershipRecord;
  try {
    record = parseRecord(raw);
  } catch (err) {
    deps.io.err(`error: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }

  // Resolved absolute-first like every other tool (cli/tools.ts). No `tailscale` means we cannot
  // check ownership, so the record is retained for a retry once it is installed again.
  if (deps.exec.which("tailscale") === null) {
    deps.io.err(
      `error: tailscale not found; retained the managed ${handlerName(record)} state for retry`,
    );
    return EXIT.FAIL;
  }

  const fingerprint = readFingerprint(deps, record);
  if (fingerprint === null) {
    deps.io.err("error: cannot inspect the managed Tailscale root; retained ownership state");
    return EXIT.FAIL;
  }

  if (fingerprint === "absent") {
    if (!removeRecord(deps)) {
      deps.io.err(
        "error: managed Tailscale root is absent but ownership state could not be removed",
      );
      return EXIT.FAIL;
    }
    deps.io.out("tailscale serve: managed root is already absent; cleared stale ownership state");
    return EXIT.OK;
  }

  if (fingerprint !== `${record.mode}|proxy:${record.proxy}`) {
    deps.io.err(
      "error: managed Tailscale root was replaced; refusing to remove the current handler",
    );
    return EXIT.FAIL;
  }

  if (!removeHandler(deps, record)) {
    deps.io.err(
      `error: managed ingress cleanup incomplete; retained ${deps.ctx.handlerFile} for retry`,
    );
    return EXIT.FAIL;
  }

  if (!removeRecord(deps)) {
    deps.io.err("error: Tailscale root was removed but ownership state could not be removed");
    return EXIT.FAIL;
  }
  deps.io.out(`tailscale serve: removed Collie's managed ${handlerName(record)} mapping`);
  return EXIT.OK;
}

/**
 * `rm -f` the record and prove it is gone. Both callers treat a surviving record as an error rather
 * than as "close enough": a record naming a mapping that no longer exists would refuse the next
 * publish, and one naming a mapping that still exists must stay so it can be retried.
 */
function removeRecord(deps: ServeDeps): boolean {
  try {
    deps.files.remove(deps.ctx.handlerFile);
  } catch {
    return false;
  }
  return !deps.files.exists(deps.ctx.handlerFile);
}

/** The live fingerprint, or null when the CLI failed or its JSON was unreadable. */
function readFingerprint(deps: ServeDeps, record: OwnershipRecord): string | null {
  const r = deps.exec.capture("tailscale", ["serve", "status", "--json"]);
  if (!r.found || r.code !== 0) return null;
  try {
    return fingerprintRoot(parseServeStatus(r.stdout), record.hostPort, record.port);
  } catch {
    return null;
  }
}

// ── Publishing ───────────────────────────────────────────────────────────────

export function cmdServe(deps: ServeDeps): number {
  // Skipping teardown would strand a mapping published BEFORE the flag was flipped on, leaving the
  // app reachable by a path the operator thinks is closed. So Variant C/E publishes nothing — and
  // still tears down. (DEPLOYMENT.md Variants C/E; bridge/config.ts exposes the flag as `skipServe`.)
  if (deps.ctx.env.COLLIE_SKIP_SERVE === "1") {
    const torn = stopTailscaleServe(deps);
    if (torn !== EXIT.OK) return torn;
    deps.io.out(
      `tailscale serve skipped (COLLIE_SKIP_SERVE=1) — bridge is on 127.0.0.1:${deps.ctx.port} only`,
    );
    return EXIT.OK;
  }

  const torn = stopTailscaleServe(deps);
  if (torn !== EXIT.OK) return torn;

  if (deps.exec.which("tailscale") === null) {
    deps.io.err("error: tailscale not found; cannot publish the tailnet front door");
    return EXIT.FAIL;
  }
  // A mapping we can't name is a mapping we can't later prove we own.
  const host = tailnetName(deps.exec);
  if (host === null) {
    deps.io.err(
      "error: cannot determine Tailscale hostname; refusing to publish an untrackable root mount",
    );
    return EXIT.FAIL;
  }

  const proxy = `http://127.0.0.1:${deps.ctx.port}`;
  const listenerPort = deps.ctx.serveMode === "http" ? deps.ctx.port : 443;
  if (!ensureRootAvailable(deps, listenerPort, deps.ctx.serveMode, proxy)) return EXIT.FAIL;

  // Write-ahead ownership: the record goes down BEFORE the serve call, so a serve that half-lands
  // still leaves something teardown can act on. It is removed again only if that call fails.
  const record: OwnershipRecord = {
    mode: deps.ctx.serveMode,
    port: listenerPort,
    hostPort: `${host}:${listenerPort}`,
    proxy,
  };
  deps.files.write(deps.ctx.handlerFile, formatRecord(record));

  const args =
    deps.ctx.serveMode === "http"
      ? ["serve", "--bg", `--http=${deps.ctx.port}`, "--set-path=/", String(deps.ctx.port)]
      : ["serve", "--bg", "--set-path=/", String(deps.ctx.port)];
  const r = deps.exec.capture("tailscale", args);
  // The shell captured this into ${CONFIG_DIR}/serve.out and `cat`-ed it on failure; the file stays
  // so an operator who went looking for it after a failed publish still finds it.
  const output = `${r.stdout}${r.stderr}`;
  deps.files.write(serveOutPath(deps.ctx), output);
  if (r.found && r.code === 0) {
    deps.io.out(
      deps.ctx.serveMode === "http"
        ? `tailscale serve (http) → tailnet :${deps.ctx.port} -> 127.0.0.1:${deps.ctx.port}`
        : `tailscale serve (https) → tailnet :443 -> 127.0.0.1:${deps.ctx.port}`,
    );
    return EXIT.OK;
  }
  deps.files.remove(deps.ctx.handlerFile);
  deps.io.out(
    deps.ctx.serveMode === "http"
      ? "note: tailscale serve failed (try 'sudo tailscale set --operator=$USER'):"
      : "note: tailscale serve (https) failed — on Headscale/.internal domains use COLLIE_SERVE_MODE=http:",
  );
  if (output.trim() !== "") deps.io.out(output.trimEnd());
  return EXIT.FAIL;
}

/** Per-instance, like every other file the CLI drops in the config dir — two instances may share one. */
export const serveOutPath = (ctx: CliContext): string =>
  `${ctx.configDir}/serve${instanceSuffix(ctx.instance)}.out`;

/** The publish-side gate. True means "go ahead"; it prints its own refusal otherwise. */
function ensureRootAvailable(
  deps: ServeDeps,
  port: number,
  protocol: ServeMode,
  expectedProxy: string,
): boolean {
  const r = deps.exec.capture("tailscale", ["serve", "status", "--json"]);
  if (!r.found || r.code !== 0) {
    deps.io.err(
      `error: cannot inspect Tailscale serve status; refusing to overwrite the root mount on :${port}`,
    );
    return false;
  }
  let verdict: Availability;
  try {
    verdict = rootAvailability(parseServeStatus(r.stdout), port, protocol, expectedProxy);
  } catch {
    deps.io.err(
      `error: invalid Tailscale serve status; refusing to overwrite the root mount on :${port}`,
    );
    return false;
  }
  if (verdict === "protocol-mismatch") {
    deps.io.err(`error: Tailscale serve :${port} already uses the opposite listener protocol`);
    return false;
  }
  if (verdict === "occupied") {
    deps.io.err(
      `error: Tailscale serve already has an unowned root mount on :${port}; refusing to overwrite it`,
    );
    return false;
  }
  if (verdict === "adoptable") {
    deps.io.out(`tailscale serve: adopting the existing Collie root mount on :${port}`);
  }
  return true;
}

/** The inverse of {@link cmdServe}: remove Collie's own mapping and nothing else. */
export const cmdUnserve = (deps: ServeDeps): number => stopTailscaleServe(deps);

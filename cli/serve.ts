import type { CliContext, ServeMode } from "./context.ts";
import { DEFAULT_SERVE_PORT, instanceSuffix, parseServePort } from "./context.ts";
import {
  fingerprintRoot,
  formatRecord,
  handlerName,
  hasRootMount,
  parseRecord,
  parseServeStatus,
  releaseManagedFrontDoor,
  type FrontDoorDeps,
  type OwnershipRecord,
  type ServeHandlers,
  type ServeStatus,
} from "../bridge/front-door.ts";
import { EXIT, type Io } from "./io.ts";
import type { Exec, Files } from "./sys.ts";
import { localBridgeHostPort, tailnetName } from "./tailnet.ts";

// The single managed front door, ported from the pre-shim `collie-ctl.sh`. ADR 0001 is the whole
// point of it: Collie manages exactly ONE `tailscale serve` mapping, records it, and only ever tears
// down a mapping still matching that record. The failure mode a bug here produces is not a broken
// Collie — it is a stranger's service silently unpublished.
//
// Two refusal directions, both preserved verbatim:
//   publishing  — a root mount we don't own is never overwritten ({@link rootAvailability});
//   teardown    — a root that no longer matches the record is never removed (`fingerprintRoot`).
//
// **The record and the teardown half now live in `bridge/front-door.ts`** — a machine that heals to
// `peer` has to take its own mapping down at boot, and that must be the same code, not a second
// copy of it. This file keeps PUBLISHING, which is a lead-and-solo act the bridge cannot reach, and
// re-exports the moved names so every existing caller (and cli/serve.test.ts) is unchanged.
export {
  fingerprintRoot,
  formatRecord,
  handlerName,
  parseRecord,
  parseServeStatus,
  type OwnershipRecord,
  type ServeHandlers,
  type ServeStatus,
};

export interface ServeDeps {
  ctx: CliContext;
  io: Io;
  exec: Exec;
  files: Files;
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
      .filter((handlers) => hasRootMount(handlers))
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

// ── Teardown ────────────────────────────────────────────────────────────────

/**
 * Remove ONLY the mapping Collie recorded as its own, through the one implementation of that rule
 * (`bridge/front-door.ts`). Kept as a named function here because `serve`, `unserve` and every
 * caller of them speak in exit codes.
 */
export const stopTailscaleServe = (deps: ServeDeps): number =>
  releaseManagedFrontDoor(frontDoorDeps(deps)) ? EXIT.OK : EXIT.FAIL;

/** The CLI's seams, narrowed to the four things teardown touches. `Exec`/`Files` fit structurally. */
const frontDoorDeps = (deps: ServeDeps): FrontDoorDeps => ({
  handlerFile: deps.ctx.handlerFile,
  io: deps.io,
  exec: deps.exec,
  files: deps.files,
});

// ── Publishing ───────────────────────────────────────────────────────────────

export function cmdServe(deps: ServeDeps): number {
  // Both refusals below come BEFORE the teardown call: a misconfigured front door must have no side
  // effect at all, and tearing down the live mapping on the way to reporting a typo would take the
  // app offline to say "I cannot read your settings".
  const requested = deps.ctx.env.COLLIE_SERVE_PORT?.trim();
  if (requested !== undefined && requested !== "" && deps.ctx.serveMode === "http") {
    // In http mode the listener IS the bridge port, so honouring both would be publishing on a port
    // neither setting names. One question, one answer.
    deps.io.err(
      "error: COLLIE_SERVE_PORT applies to the https front door only — under COLLIE_SERVE_MODE=http " +
        "the tailnet listener is COLLIE_PORT. Unset one of them.",
    );
    return EXIT.FAIL;
  }
  const parsedServePort = parseServePort(deps.ctx.env);
  if (!parsedServePort.ok) {
    deps.io.err(`error: ${parsedServePort.message}`);
    return EXIT.FAIL;
  }
  const httpsPort = parsedServePort.port;

  // Skipping teardown would strand a mapping published BEFORE the flag was flipped on, leaving the
  // app reachable by a path the operator thinks is closed. So Variant C/E publishes nothing — and
  // still tears down. (DEPLOYMENT.md Variants C/E; bridge/config.ts exposes the flag as `skipServe`.)
  if (deps.ctx.env.COLLIE_SKIP_SERVE === "1") {
    const torn = stopTailscaleServe(deps);
    if (torn !== EXIT.OK) return torn;
    deps.io.out(
      // F13: name the bind, not loopback — under Variant C a peer is routinely bound elsewhere
      // and this line was the one telling the operator to go and look at a dead port.
      `tailscale serve skipped (COLLIE_SKIP_SERVE=1) — bridge is on ${localBridgeHostPort(deps.ctx.env, deps.ctx.port)} only`,
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
  const listenerPort = deps.ctx.serveMode === "http" ? deps.ctx.port : httpsPort;
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

  const args = publishArgs(deps.ctx.serveMode, deps.ctx.port, httpsPort);
  const r = deps.exec.capture("tailscale", args);
  // The shell captured this into ${CONFIG_DIR}/serve.out and `cat`-ed it on failure; the file stays
  // so an operator who went looking for it after a failed publish still finds it.
  const output = `${r.stdout}${r.stderr}`;
  deps.files.write(serveOutPath(deps.ctx), output);
  if (r.found && r.code === 0) {
    deps.io.out(
      deps.ctx.serveMode === "http"
        ? `tailscale serve (http) → tailnet :${deps.ctx.port} -> 127.0.0.1:${deps.ctx.port}`
        : `tailscale serve (https) → tailnet :${httpsPort} -> 127.0.0.1:${deps.ctx.port}`,
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

/**
 * The `tailscale serve` publish invocation.
 *
 * On the default https port the argument list stays byte-identical to the one the shell shipped:
 * bare `tailscale serve` already means :443, so a host that never set `COLLIE_SERVE_PORT` publishes
 * exactly what it published before, down to the argv. Only a chosen port adds `--https=<port>`.
 */
function publishArgs(mode: ServeMode, bridgePort: number, httpsPort: number): string[] {
  const target = String(bridgePort);
  if (mode === "http") return ["serve", "--bg", `--http=${bridgePort}`, "--set-path=/", target];
  if (httpsPort === DEFAULT_SERVE_PORT) return ["serve", "--bg", "--set-path=/", target];
  return ["serve", "--bg", `--https=${httpsPort}`, "--set-path=/", target];
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

import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import type { PackMode } from "./types.ts";
import { findTool } from "./tools.ts";

// The ONE managed front door's ownership record, and the only code that takes it down. ADR 0001 is
// the whole point of this module: Collie manages exactly one `tailscale serve` mapping, records it,
// and only ever tears down a mapping still matching that record. The failure mode a bug here
// produces is not a broken Collie — it is a stranger's service silently unpublished.
//
// ── WHY THIS IS IN `bridge/` AND NOT IN `cli/serve.ts`, WHERE IT WAS ─────────
// Two processes now have to take that mapping down, and there must not be two implementations of
// "only what we recorded":
//
//   • `collie unserve` / the teardown half of `collie serve` — the operator's own verb;
//   • **the bridge, at boot, when it comes up as a `peer`** — the gap a live takeover drill found.
//     A deposed lead self-heals to `peer` on materials it already holds, but its `tailscale serve`
//     mapping outlived the crown. Two things went wrong at once: the peer listener could not bind
//     its tailnet address, because tailscaled already owned that port, so the bridge crash-looped;
//     and the public hostname kept routing into a machine that answers nothing. Neither is fixable
//     by the new lead — a front door is the losing machine's own to close (ADR 0001) — so the
//     losing machine closes it itself, through this exact code path and no other.
//
// The bridge does not import from `cli/`, so the shared half lives here and `cli/serve.ts` imports
// it. Publishing did NOT move: a peer must never be able to open a door, so the only thing it can
// reach is the closing half.
//
// Every outside effect is a seam ({@link FrontDoorDeps}) — `bun test` drives the whole teardown,
// including the refusal, without a tailnet.

// ── The ownership record ─────────────────────────────────────────────────────
// One line in the config dir: `<mode>:<port>|<HostPort>|<proxy>`, e.g.
// `https:443|host.ts.net:443|http://127.0.0.1:8787`. The format is NOT versioned, moved or
// migrated — a host upgrading from the shell to the binary must find its existing record valid.

/** `https` publishes on :443 with Tailscale's certificate; `http` publishes the bridge port plain. */
export type ServeMode = "https" | "http";

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

/**
 * `""` for the unsuffixed instance, `-v1` for `COLLIE_INSTANCE=v1`.
 *
 * Here rather than in `cli/context.ts` (which re-exports it as `instanceSuffix`) for one reason: the
 * bridge has to name the SAME record file the CLI wrote, and a second copy of this join is a second
 * instance quietly tearing down the first's front door.
 */
export const instanceSuffixOf = (instance: string | null | undefined): string => {
  const raw = (instance ?? "").trim();
  return raw === "" ? "" : `-${raw}`;
};

/** Where the ownership record for one instance lives. The one place this path is written. */
export const managedHandlerPath = (configDir: string, suffix: string): string =>
  join(configDir, `tailscale-managed-handler${suffix}`);

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

/** Does this serve config carry a root mount at all? Shared with `cli/serve.ts`'s publish gate. */
export const hasRootMount = (handlers: ServeHandlers): boolean =>
  Object.prototype.hasOwnProperty.call(handlers, "/");

/**
 * What currently owns the root mount we recorded: `absent`, or `<protocol>|proxy:<target>`. This is
 * the evidence teardown checks before removing anything (the pre-shim `collie-ctl.sh`).
 */
export function fingerprintRoot(status: ServeStatus, hostPort: string, port: number): string {
  const handlers = status.Web?.[hostPort]?.Handlers ?? {};
  if (!hasRootMount(handlers)) return "absent";
  const listener = status.TCP?.[String(port)];
  const protocol =
    listener?.HTTP === true ? "http" : listener?.HTTPS === true ? "https" : "other";
  const proxy = handlers["/"]?.Proxy;
  return proxy !== undefined && proxy.length > 0
    ? `${protocol}|proxy:${proxy}`
    : `${protocol}|other`;
}

// ── Teardown ─────────────────────────────────────────────────────────────────

/** Running one tool, captured. Structurally satisfied by `cli/sys.ts`'s `Exec`. */
export interface FrontDoorExec {
  /** Absolute path of `tool`, or null when it isn't installed. */
  which(tool: string): string | null;
  capture(
    tool: string,
    args: readonly string[],
  ): { code: number; stdout: string; stderr: string; found: boolean };
}

/** The three file operations teardown needs. Structurally satisfied by `cli/sys.ts`'s `Files`. */
export interface FrontDoorFiles {
  exists(p: string): boolean;
  /** File contents, or null when missing/unreadable. */
  read(p: string): string | null;
  /** Remove a file. Missing is success — this is `rm -f`. */
  remove(p: string): void;
}

export interface FrontDoorIo {
  out(line: string): void;
  err(line: string): void;
}

export interface FrontDoorDeps {
  /** The ownership record for THIS instance — {@link managedHandlerPath}. */
  handlerFile: string;
  io: FrontDoorIo;
  exec: FrontDoorExec;
  files: FrontDoorFiles;
}

/**
 * `tailscale serve … off` for ONE handler, scoped to the listener and the root path — never a
 * blanket reset, and never an unscoped shutdown of :443 that could take down a mapping someone else
 * put there. "Already gone" is success so teardown is idempotent; any other failure is real.
 */
function removeHandler(deps: FrontDoorDeps, record: OwnershipRecord): boolean {
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
 *
 * Returns whether nothing of ours is published any more. The bridge treats `false` as a warning and
 * comes up regardless (a peer that failed to unpublish must still run); the CLI turns it into a
 * non-zero exit.
 */
export function releaseManagedFrontDoor(deps: FrontDoorDeps): boolean {
  const raw = deps.files.read(deps.handlerFile);
  if (raw === null) {
    deps.io.out("tailscale serve: no Collie-managed mapping recorded");
    return true;
  }

  let record: OwnershipRecord;
  try {
    record = parseRecord(raw);
  } catch (err) {
    deps.io.err(`error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  // Resolved absolute-first like every other tool (bridge/tools.ts). No `tailscale` means we cannot
  // check ownership, so the record is retained for a retry once it is installed again.
  if (deps.exec.which("tailscale") === null) {
    deps.io.err(
      `error: tailscale not found; retained the managed ${handlerName(record)} state for retry`,
    );
    return false;
  }

  const fingerprint = readFingerprint(deps, record);
  if (fingerprint === null) {
    deps.io.err("error: cannot inspect the managed Tailscale root; retained ownership state");
    return false;
  }

  if (fingerprint === "absent") {
    if (!removeRecord(deps)) {
      deps.io.err(
        "error: managed Tailscale root is absent but ownership state could not be removed",
      );
      return false;
    }
    deps.io.out("tailscale serve: managed root is already absent; cleared stale ownership state");
    return true;
  }

  if (fingerprint !== `${record.mode}|proxy:${record.proxy}`) {
    deps.io.err(
      "error: managed Tailscale root was replaced; refusing to remove the current handler",
    );
    return false;
  }

  if (!removeHandler(deps, record)) {
    deps.io.err(
      `error: managed ingress cleanup incomplete; retained ${deps.handlerFile} for retry`,
    );
    return false;
  }

  if (!removeRecord(deps)) {
    deps.io.err("error: Tailscale root was removed but ownership state could not be removed");
    return false;
  }
  deps.io.out(`tailscale serve: removed Collie's managed ${handlerName(record)} mapping`);
  return true;
}

/**
 * `rm -f` the record and prove it is gone. Both callers treat a surviving record as an error rather
 * than as "close enough": a record naming a mapping that no longer exists would refuse the next
 * publish, and one naming a mapping that still exists must stay so it can be retried.
 */
function removeRecord(deps: FrontDoorDeps): boolean {
  try {
    deps.files.remove(deps.handlerFile);
  } catch {
    return false;
  }
  return !deps.files.exists(deps.handlerFile);
}

/** The live fingerprint, or null when the CLI failed or its JSON was unreadable. */
function readFingerprint(deps: FrontDoorDeps, record: OwnershipRecord): string | null {
  const r = deps.exec.capture("tailscale", ["serve", "status", "--json"]);
  if (!r.found || r.code !== 0) return null;
  try {
    return fingerprintRoot(parseServeStatus(r.stdout), record.hostPort, record.port);
  } catch {
    return null;
  }
}

// ── Should this process take its own front door down? ────────────────────────

/**
 * The whole decision, as data (PACK_PROTOCOL.md §3: a peer publishes nothing; ADR 0013).
 *
 * | mode   | deposed | a record of ours | verdict |
 * |--------|---------|------------------|---------|
 * | solo   | –       | –                | keep    |
 * | lead   | no      | –                | keep    |
 * | lead   | yes     | yes              | release |
 * | peer   | –       | yes              | release |
 * | any    | –       | no               | keep    |
 *
 * `deposed` covers the machine whose demotion did NOT complete — a parked ex-lead still holds a
 * front door for a pack that has moved on, and its own health check now fails behind it, so the
 * mapping is doing nothing but black-holing the pack's hostname.
 *
 * **A missing record is `keep`, not "look around".** An unrecorded mapping is by definition not
 * ours (ADR 0001), and a boot that went hunting for one would be exactly the behaviour this file
 * exists to make impossible.
 */
export function shouldReleaseFrontDoor(input: {
  mode: PackMode;
  deposed: boolean;
  hasRecord: boolean;
}): boolean {
  if (!input.hasRecord) return false;
  return input.mode === "peer" || input.deposed;
}

// ── The bridge's own seams ───────────────────────────────────────────────────
// The CLI passes its `Exec`/`Files` (cli/sys.ts). The bridge has neither, and pulling them in would
// drag a service manager, a launchd plist writer and a socket dialler into a process that wants two
// `tailscale` calls — so these are the two implementations, and nothing else in the bridge uses them.

/** `spawnSync`, with the tool resolved absolute-first under systemd's minimal PATH. */
export function realFrontDoorExec(
  env: Record<string, string | undefined>,
  home: string,
): FrontDoorExec {
  const resolve = (tool: string): string | null => findTool(tool, env, home);
  return {
    which: resolve,
    capture(tool, args) {
      const bin = resolve(tool);
      if (bin === null) return { code: 127, stdout: "", stderr: "", found: false };
      const r = spawnSync(bin, [...args], { encoding: "utf8" });
      return {
        code: r.status ?? 1,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        found: true,
      };
    },
  };
}

/**
 * The record file, read and removed.
 *
 * The path is derived from this process's own config dir and never from a request — the containment
 * rule `bridge/journal/files.ts` states is about client-supplied paths, and nothing here is one.
 */
export const realFrontDoorFiles: FrontDoorFiles = {
  exists: (p) => existsSync(p),
  read: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  remove: (p) => rmSync(p, { force: true }),
};

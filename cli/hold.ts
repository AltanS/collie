import { once } from "node:events";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import { holdSocketPath } from "../bridge/beacon/paths.ts";
import { parseProcStartTime, procStatPath } from "../bridge/beacon/liveness.ts";
import type { JsonObject } from "../bridge/json.ts";
import { asJsonString, parseJsonObject } from "../web/src/lib/json.ts";
import {
  decisionOutput,
  HOLD_CONNECT_MS,
  HOLD_GRACE_MS,
  HOLD_WIRE_VERSION,
  parseHoldReply,
  shownInputOf,
  isCwd,
  type HoldDecision,
  type HoldProfile,
  type HoldRequest,
} from "../web/src/lib/surface/hold.ts";
import { loadProfiles } from "../web/src/lib/surface/profile.ts";
import { BEACON_HARNESS, edgeStateDirs, privateDir, readEnvMarkers, type EdgeTargetDeps } from "./beacon.ts";
import type { CliContext } from "./context.ts";
import { EXIT } from "./io.ts";
import type { Files } from "./sys.ts";

// `collie beacon hold`: the agent's permission hook (M56 spec 12). `collie hooks install claude
// --hold-permissions` registers it. It holds one permission request for a person's tap on the phone.
//
// The flow: the harness runs this with the request as JSON on stdin and waits. It connects to the
// local socket of each Collie bridge on this machine, posts the request, and waits for a decision.
// The first decision wins: it prints the decision JSON, tells the other bridges "answered elsewhere",
// and exits. With no decision it prints nothing, and the harness shows its own dialog as before.
//
// Rules, each absolute:
//  - It prints nothing and exits 0 on every error: no socket, a slow socket, bad JSON, a closed
//    connection, a bridge that dies. Printing nothing is "no decision", so the dialog takes over.
//  - It holds only for the profile's hold event. Every other event exits at once.
//  - Each socket gets 200 ms to accept. The hold ends at the profile's limit plus a short grace,
//    below the hook timeout the install writes.
//  - It never decides alone. The decision is only ever what a bridge sends for a person's tap.
//  - No token and no secret. The socket is a file in the bridge's own state directory, mode 0600.

export { holdSocketPath };

/**
 * The socket of every live bridge, found as the edge emitter finds its targets (M56 spec 11): each
 * entry in the hook target registry whose process still runs, plus the hook's own state dir when
 * COLLIE_STATE_DIR names it or when no bridge is listed. A dead entry is skipped and its file
 * deleted, by the same walk.
 */
export function holdSocketPaths(deps: EdgeTargetDeps): string[] {
  return edgeStateDirs(deps).map((dir) => holdSocketPath(dir));
}

/**
 * Whether a socket path is safe to post a request to, checked before the connect. Its folder and the
 * state dir above it are this user's own (real folders, owned by this uid, writable by nobody else),
 * and the socket is a socket of this uid, never a link or a plain file. Another user who could plant a
 * socket there, or swap the hold folder inside a state dir they can write, would read the request
 * and could answer it.
 */
export function holdSocketSafe(deps: EdgeTargetDeps, path: string): boolean {
  if (!privateDir(deps, dirname(path)) || !privateDir(deps, dirname(dirname(path)))) return false;
  if (deps.files.entryType(path) !== "other") return false;
  return deps.uid === undefined || deps.files.ownerUid(path) === deps.uid;
}

/** One open connection to a bridge, line based. */
export interface HoldSocket {
  send(line: string): void;
  /** Called once per line the bridge sends. */
  onLine(listener: (line: string) => void): void;
  /** Called once when the connection ends, for any reason. */
  onClose(listener: () => void): void;
  close(): void;
}

export interface HoldDeps {
  readonly ctx: CliContext;
  readonly files: Files;
  readStdin(): Promise<string>;
  /** The agent's pid: `process.ppid` in production. */
  readonly agentPid: number;
  /** The owner uid the registry folder must have; undefined skips the check (Windows, tests). */
  readonly uid?: number;
  /** The socket paths of every live bridge. Defaults to {@link holdSocketPaths}. */
  sockets?(): readonly string[];
  /** Connect within `ms`, or null. Never throws. */
  connect(path: string, ms: number): Promise<HoldSocket | null>;
  /** Write the decision to stdout. */
  print(text: string): Promise<void>;
  readonly now?: () => number;
  /** Defaults to a real timer. */
  readonly after?: (ms: number, run: () => void) => () => void;
}

/** The request line for a payload, or null when this hook has nothing to hold. */
export function holdRequestOf(deps: HoldDeps, payload: JsonObject, hold: HoldProfile): HoldRequest | null {
  if (payload.hook_event_name !== hold.event) return null;
  const tool = asJsonString(payload.tool_name);
  if (tool === undefined || !/^[\x20-\x7e]{1,128}$/u.test(tool)) return null;
  const markers = readEnvMarkers(deps.ctx.env);
  if (markers.length === 0) return null;
  const stat = deps.files.read(procStatPath(deps.agentPid));
  const pidStartTime = stat === null ? null : parseProcStartTime(stat);
  if (pidStartTime === null) return null;
  const agentRaw = asJsonString(payload.agent_id);
  const agent = agentRaw !== undefined && /^[\x20-\x7e]{1,128}$/u.test(agentRaw) ? agentRaw : null;
  const typeRaw = asJsonString(payload.agent_type);
  const agentType = agent !== null && typeRaw !== undefined && /^[\x20-\x7e]{1,128}$/u.test(typeRaw) ? typeRaw : undefined;
  const shown = shownInputOf(payload.tool_input, hold.inputShown, hold.inputDetails[tool]);
  const cwd = asJsonString(payload.cwd);
  const request: HoldRequest = {
    v: HOLD_WIRE_VERSION,
    harness: BEACON_HARNESS,
    pid: deps.agentPid,
    pidStartTime,
    markers,
    tool,
    input: shown.text,
    agent,
    // A cut input is answered on the screen: a person cannot judge what the card does not show.
    hold: !hold.screenOnly.includes(tool) && !shown.cut,
    at: (deps.now ?? Date.now)(),
  };
  // The folder lets the bridge match a dialog that names a file by its path below the folder.
  // The subagent's type lets the bridge tell two subagents' dialogs apart by the dialog's mark.
  const withType = agentType === undefined ? request : { ...request, agentType };
  const withCwd = cwd !== undefined && isCwd(cwd) ? { ...withType, cwd } : withType;
  return shown.cut ? { ...withCwd, cut: true } : withCwd;
}

/** Connect to every socket at once, each with its own limit. The ones that answered, in order. */
async function connectAll(deps: HoldDeps, paths: readonly string[]): Promise<HoldSocket[]> {
  const sockets = await Promise.all(paths.map((path) => deps.connect(path, HOLD_CONNECT_MS).catch(() => null)));
  return sockets.filter((socket): socket is HoldSocket => socket !== null);
}

/** Wait for the first decision from any socket, or for all of them to close, or for the limit. */
function firstDecision(deps: HoldDeps, sockets: readonly HoldSocket[], limitMs: number): Promise<{ decision: HoldDecision; from: HoldSocket } | null> {
  return new Promise((resolve) => {
    let open = sockets.length;
    let done = false;
    const after = deps.after ?? ((ms: number, run: () => void) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    });
    const finish = (value: { decision: HoldDecision; from: HoldSocket } | null): void => {
      if (done) return;
      done = true;
      cancel();
      resolve(value);
    };
    const cancel = after(limitMs, () => finish(null));
    for (const socket of sockets) {
      socket.onLine((line) => {
        const decision = parseHoldReply(line);
        if (decision !== null) finish({ decision, from: socket });
      });
      socket.onClose(() => {
        open -= 1;
        if (open <= 0) finish(null);
      });
    }
  });
}

/**
 * `collie beacon hold`: one permission request in, at most one decision out. ALWAYS returns
 * `EXIT.OK`, and prints nothing unless a bridge sent a decision for a person's tap.
 */
export async function cmdBeaconHold(deps: HoldDeps): Promise<number> {
  let sockets: HoldSocket[] = [];
  try {
    const hold = loadProfiles().get(BEACON_HARNESS)?.hold;
    if (hold === undefined) return EXIT.OK;
    // The environment gate first, as the emitter does: outside a multiplexer nothing is read.
    if (readEnvMarkers(deps.ctx.env).length === 0) return EXIT.OK;
    const payload = parseJsonObject(await deps.readStdin());
    if (payload === undefined) return EXIT.OK;
    const request = holdRequestOf(deps, payload, hold);
    if (request === null) return EXIT.OK;
    const paths = [...new Set(deps.sockets?.() ?? holdSocketPaths(deps))].filter((path) => holdSocketSafe(deps, path));
    if (paths.length === 0) return EXIT.OK;
    sockets = await connectAll(deps, paths);
    if (sockets.length === 0) return EXIT.OK;
    const line = `${JSON.stringify(request)}\n`;
    for (const socket of sockets) socket.send(line);
    // A screen-only tool: the bridges take the line as an edge. Nothing is held.
    if (!request.hold) return EXIT.OK;
    const won = await firstDecision(deps, sockets, hold.limitMs + HOLD_GRACE_MS);
    if (won === null) return EXIT.OK;
    for (const socket of sockets) if (socket !== won.from) socket.send(`${JSON.stringify({ done: "elsewhere" })}\n`);
    await deps.print(decisionOutput(hold.event, won.decision, hold.denyMessage));
    return EXIT.OK;
  } catch {
    return EXIT.OK;
  } finally {
    for (const socket of sockets) {
      try {
        socket.close();
      } catch {
        // A socket that will not close is a socket the process exit closes.
      }
    }
  }
}

/** A real socket connection through `node:net`, or null when it does not accept within `ms`. */
export async function netConnect(path: string, ms: number): Promise<HoldSocket | null> {
  const conn = createConnection({ path });
  // An error after the connect ends the socket through `close`; before it, it loses the race below.
  conn.on("error", () => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((done) => {
    timer = setTimeout(() => done(false), ms);
  });
  const accepted = await Promise.race([once(conn, "connect").then(() => true, () => false), late]);
  clearTimeout(timer);
  if (!accepted) {
    conn.destroy();
    return null;
  }
  const lineListeners: ((line: string) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  let buffer = "";
  let closed = false;
  conn.setEncoding("utf8");
  conn.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 64 * 1024) {
      conn.destroy();
      return;
    }
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      for (const listener of lineListeners) listener(line);
      at = buffer.indexOf("\n");
    }
  });
  conn.on("close", () => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener();
  });
  return {
    send: (line) => {
      if (!closed) conn.write(line);
    },
    onLine: (listener) => lineListeners.push(listener),
    onClose: (listener) => closeListeners.push(listener),
    // `end` flushes a last line (the "answered elsewhere" note) before the close. The destroy
    // after it is a backstop for a bridge that never closes its side.
    close: () => {
      conn.end();
      setTimeout(() => conn.destroy(), 200).unref();
    },
  };
}

/** The verb, with its dependency construction inside the same guarantee. */
export async function runBeaconHold(build: () => HoldDeps): Promise<number> {
  try {
    return await cmdBeaconHold(build());
  } catch {
    return EXIT.OK;
  }
}

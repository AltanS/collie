// Hermes's door (ADR 0141, ADR 0142): the gateway daemon the person's own Hermes runs. Hermes's Ink front
// end is one client of it; the bridge is a second, for one send, on the wire Ink speaks.
//
// THE WIRE. The control socket `$HERMES_HOME/gateway.sock` answers one JSON line per connection:
// `identify` says the gateway's state, capabilities, instance and loopback `api_origin`; `session-ticket`
// mints a single-use ticket for a same-uid peer. The ticket opens `ws://<api_origin>/api/ws` with the
// subprotocols `hermes-gateway-v1` and `hermes-gateway-ticket.<ticket>`. On it the door attaches to the
// session (`session.resume`), submits (`prompt.submit`), and leaves (`session.detach`, then close 1000).
// Every answer is read in `hermes-wire.ts`.
//
// WHAT IT CALLS (ADR 0142 point 4). An `interactive` ticket also grants approve, respond and control, so
// the door is bounded by what it sends: {@link DOOR_METHODS} and nothing else. No `runtime.describe`, no
// `gateway.ping`, no `session.list`, and never `client.capabilities {server_requests: true}`: a request
// the gateway sends anyway is answered "method not found" at once, so it stays the person's at the desk.
// The admission is a hint (ADR 0024); the journal proves the turn (ADR 0141 point 4), so the door never
// waits on `prompt.receipt` for a turn that can outlast the pane lock.
//
// ABSENT OR REFUSED (SPEC V25). No home, no socket, or a socket nobody listens on is no gateway: the door
// is absent and the screen path is the ordinary one. A gateway with no session authority is a Hermes this
// door cannot speak to, also absent. A socket that fails the path walk, a gateway that answers but is not
// ready, not on loopback or not this home's, and a pane the binding cannot name refuse. Only
// `gateway.sock` is read: a gateway that put its socket elsewhere behind `gateway.sock.path` is absent.
//
// BEFORE AND AFTER THE SUBMIT (ADR 0141 point 2). Everything up to the `prompt.submit` frame (the ticket,
// the WebSocket, the attach) refuses when it fails, each step inside its own short cap so the screen path
// keeps its time: nothing was handed over. The gateway's own error answer to the submit refuses too (an
// admission conflict is V12's same id with other text). Once the frame is out, a drop, a timeout or an
// answer this build cannot read throws: the text may have arrived, so it is never typed again.
//
// THE BINDING is not the gateway's to give (SPEC V16): its live list carries no pane, and Herdr's
// `agent_session` names the wrong session with two Ink panes on one gateway. The session reaches the door
// through `bind`, and its id is checked before it goes on the wire.

import { connect } from "node:net";
import { join } from "node:path";

import type { JsonValue } from "../json.ts";
import { isHermesSessionId } from "../journal/hermes.ts";
import { describeFault, socketFault, type SocketFault } from "../mux/durable/client.ts";
import type { BoundDoor, Door, DoorAnswer, DoorSend, DoorTarget, Preflight } from "./door.ts";
import { readAdmission, readControlLine, readFrame, readIdentify, readSnapshot, readTicket, type Attached, type Endpoint } from "./hermes-wire.ts";

/** The harness id Hermes's door serves. */
export const HERMES_DOOR = "hermes";

/** The only methods the door calls on the gateway (ADR 0142 point 4). */
export const DOOR_METHODS = ["session.resume", "prompt.submit", "prompt.receipt", "session.detach"] as const;
type DoorMethod = (typeof DOOR_METHODS)[number];

/** The subprotocol the gateway must echo; the ticket rides as a second one. */
export const GATEWAY_PROTOCOL = "hermes-gateway-v1";

/** Every `input_id` the door sends starts here: the door and Ink act as one principal (ADR 0142 point 5). */
export const INPUT_ID_PREFIX = "collie-";

/** How long one control-socket question gets. */
export const CONTROL_MS = 1000;

/** How long the WebSocket gets to open and the gateway to say `gateway.ready`. */
export const READY_MS = 1000;

/** How long the attach gets. */
export const RESUME_MS = 1000;

/** How long the detach gets before the close: the close alone also ends the subscription. */
const DETACH_MS = 500;

/** The largest control answer read. An `identify` is a few hundred bytes. */
const CONTROL_MAX_BYTES = 64 * 1024;

/** The control socket's connect found nobody listening: no gateway runs. */
export class GatewayGone extends Error {}

/** The socket, the disk and the WebSocket, as the door touches them. A test supplies its own. */
export interface GatewayIo {
  /** Why the control socket may not be dialled (ADR 0142 point 2), or null when it may. */
  fault(path: string): Promise<SocketFault | null>;
  /** One JSON line out, one JSON value back. A refused or missing socket throws {@link GatewayGone}. */
  control(path: string, request: JsonValue, signal: AbortSignal): Promise<JsonValue>;
  /** A WebSocket to `url` with `protocols`. It sends no `Origin` header. */
  dial(url: string, protocols: string[]): WebSocket;
}

/** One request on a control socket, read up to its first newline. */
function controlQuery(path: string, request: JsonValue, signal: AbortSignal): Promise<JsonValue> {
  return new Promise((resolveAnswer, reject) => {
    const sock = connect({ path });
    let buffer = "";
    let done = false;
    const finish = (settle: () => void): void => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", onAbort);
      sock.destroy();
      settle();
    };
    const onAbort = (): void => finish(() => reject(new Error("the control socket did not answer in time")));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort);
    sock.on("connect", () => sock.write(`${JSON.stringify(request)}\n`));
    sock.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        const answer = readControlLine(buffer.slice(0, newline));
        finish(() => (answer === null ? reject(new Error("the control socket answered something that is not JSON")) : resolveAnswer(answer)));
      } else if (buffer.length > CONTROL_MAX_BYTES) finish(() => reject(new Error("the control socket's answer is too large")));
    });
    sock.on("end", () => finish(() => reject(new Error("the control socket closed with no answer"))));
    sock.on("error", (err: NodeJS.ErrnoException) => {
      finish(() => reject(err.code === "ECONNREFUSED" || err.code === "ENOENT" ? new GatewayGone(`nothing listens on ${path}`) : err));
    });
  });
}

/** The real socket walk, control socket and WebSocket. */
export const SYSTEM_GATEWAY_IO: GatewayIo = {
  fault: (path) => socketFault(path, undefined, "owned"),
  control: (path, request, signal) => controlQuery(path, request, signal),
  dial: (url, protocols) => new WebSocket(url, protocols),
};

/** Which session the pane shows, by identity (SPEC V16), or why it cannot say. */
export type HermesBinding = { readonly ok: true; readonly sessionId: string } | { readonly ok: false; readonly why: string };

/** What Hermes's door needs from the session it serves. */
export interface HermesDoorDeps {
  /** `$HERMES_HOME`, the folder that holds `gateway.sock`. */
  readonly home: string;
  /** The Hermes session this pane shows (the identity binding, SPEC V16). */
  bind(target: DoorTarget, signal: AbortSignal): Promise<HermesBinding>;
  readonly io?: GatewayIo;
}

/** A step before the submit frame failed: nothing was handed over. */
class Refusal extends Error {}

/** The gateway answered a call with an error. */
class RpcError extends Error {}

/** `work`, or a rejection after `ms`. */
async function capped<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer in ${String(ms)} ms`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** `work`, with any failure turned into a {@link Refusal} that names `step`; a refusal passes as it is. */
async function refusing<T>(step: string, work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof Refusal) throw err;
    throw new Refusal(`${step}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** One JSON-RPC connection, for one send, that can only call {@link DOOR_METHODS}. */
class GatewayRpc {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (value: JsonValue) => void; reject: (err: Error) => void }>();
  private ended: string | null = null;
  /** Settles when the socket opened and the gateway said `gateway.ready`. */
  readonly ready: Promise<void>;

  constructor(
    private readonly ws: WebSocket,
    signal: AbortSignal,
  ) {
    let ready!: () => void;
    let notReady!: (err: Error) => void;
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      ready = resolveReady;
      notReady = rejectReady;
    });
    // A rejection nobody waits on yet must not surface as unhandled.
    this.ready.catch(() => undefined);
    ws.addEventListener("message", (message) => this.frame(String(message.data), ready));
    ws.addEventListener("close", (event) => {
      this.end(`the gateway closed the connection (${String(event.code)})`);
      notReady(new Error(this.ended ?? "closed"));
    });
    ws.addEventListener("error", () => this.end("the connection to the gateway failed"));
    const onAbort = (): void => {
      this.end("the send ran out of time");
      notReady(new Error("the send ran out of time"));
      this.close();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  private end(why: string): void {
    this.ended ??= why;
    for (const call of this.pending.values()) call.reject(new Error(why));
    this.pending.clear();
  }

  private frame(text: string, ready: () => void): void {
    const frame = readFrame(text);
    if (frame === null || frame.kind === "event") return;
    if (frame.kind === "ready") return ready();
    if (frame.kind === "request") {
      // The door answers no request from the gateway (ADR 0142 point 4), at once, so nobody waits on it.
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "method not found" } }));
      return;
    }
    const call = this.pending.get(frame.id);
    if (call === undefined) return;
    this.pending.delete(frame.id);
    if (frame.kind === "error") call.reject(new RpcError(frame.message));
    else call.resolve(frame.result);
  }

  /** Call `method`; an error answer rejects with {@link RpcError}, a lost connection with a plain Error. */
  call(method: DoorMethod, params: { readonly [key: string]: string }): Promise<JsonValue> {
    if (this.ended !== null || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(this.ended ?? "not connected"));
    const id = ++this.nextId;
    return new Promise((resolveCall, reject) => {
      this.pending.set(id, { resolve: resolveCall, reject });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  close(): void {
    if (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, "collie door done");
  }
}

/** The WebSocket open, or why not. */
function opened(ws: WebSocket, signal: AbortSignal): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolveOpen, reject) => {
    ws.addEventListener("open", () => resolveOpen(), { once: true });
    ws.addEventListener("close", (event) => reject(new Error(`the gateway refused the WebSocket (${String(event.code)})`)), { once: true });
    signal.addEventListener("abort", () => reject(new Error("the WebSocket did not open in time")), { once: true });
  });
}

/** The admission's hint. Admission says `queued` for an idle session too, so busy comes from the attach. */
function answerOf(admission: JsonValue, attached: Attached, inputId: string): DoorAnswer {
  const receipt = readAdmission(admission);
  if (receipt === null) throw new Error("the gateway admitted the send with no receipt Collie reads");
  // A new admission is never terminal at once, and our id already in the queue was admitted before.
  if (receipt.status === "terminal" || attached.pendingIds.includes(inputId)) return { kind: "replayed" };
  return { kind: attached.busy ? "queued" : "taken" };
}

/** Hermes's door for one session. */
export function hermesDoor(deps: HermesDoorDeps): Door {
  const io = deps.io ?? SYSTEM_GATEWAY_IO;
  const path = join(deps.home, "gateway.sock");

  /** Everything before the submit frame: the walk, the ticket, the WebSocket and the attach. */
  const attach = async (endpoint: Endpoint, sessionId: string, signal: AbortSignal, onDial: (rpc: GatewayRpc) => void): Promise<{ rpc: GatewayRpc; attached: Attached }> => {
    const fault = await io.fault(path);
    if (fault !== null) throw new Refusal(`the control socket: ${describeFault(fault)}`);
    const ticketRequest = { protocol: 1, id: 1, verb: "session-ticket", params: { profile_id: endpoint.profileId, instance_id: endpoint.instanceId, purpose: "interactive" } };
    const grant = await refusing("session-ticket", io.control(path, ticketRequest, AbortSignal.any([signal, AbortSignal.timeout(CONTROL_MS)])));
    const ticket = readTicket(grant, endpoint.instanceId);
    if (ticket === null) throw new Refusal("the gateway minted no ticket");
    const ws = io.dial(endpoint.url, [GATEWAY_PROTOCOL, `hermes-gateway-ticket.${ticket}`]);
    const rpc = new GatewayRpc(ws, signal);
    onDial(rpc);
    await refusing("the gateway", capped(READY_MS, opened(ws, signal).then(() => rpc.ready)));
    if (ws.protocol !== GATEWAY_PROTOCOL) throw new Refusal(`the gateway speaks ${ws.protocol === "" ? "no protocol" : ws.protocol}`);
    const snapshot = await refusing("session.resume", capped(RESUME_MS, rpc.call("session.resume", { session_id: sessionId })));
    const attached = readSnapshot(snapshot, sessionId);
    if (attached === null) throw new Refusal("the gateway attached another session");
    return { rpc, attached };
  };

  /** The attach and the submit. Any failure before the submit frame, a throw of any kind, refuses. */
  const handOver = async (endpoint: Endpoint, sessionId: string, send: DoorSend, signal: AbortSignal, onDial: (rpc: GatewayRpc) => void, onAttach: (attached: Attached) => void): Promise<DoorAnswer> => {
    const { rpc, attached } = await refusing("before the submit", attach(endpoint, sessionId, signal, onDial));
    onAttach(attached);
    const inputId = `${INPUT_ID_PREFIX}${send.requestId}`;
    let admission: JsonValue;
    try {
      admission = await rpc.call("prompt.submit", { session_id: sessionId, text: send.text, input_id: inputId });
    } catch (err) {
      // The gateway's own error answer admitted nothing (an admission conflict included); a loss may have.
      if (err instanceof RpcError) throw new Refusal(`prompt.submit: ${err.message}`);
      throw err;
    }
    return answerOf(admission, attached, inputId);
  };

  const bound = (endpoint: Endpoint, sessionId: string): BoundDoor => ({
    async submit(send: DoorSend, signal: AbortSignal): Promise<DoorAnswer> {
      let rpc: GatewayRpc | undefined;
      let attached: Attached | undefined;
      try {
        return await handOver(
          endpoint,
          sessionId,
          send,
          signal,
          (conn) => (rpc = conn),
          (snapshot) => (attached = snapshot),
        );
      } catch (err) {
        if (err instanceof Refusal) return { kind: "refused", why: err.message };
        throw err;
      } finally {
        if (rpc !== undefined) {
          if (attached !== undefined) await capped(DETACH_MS, rpc.call("session.detach", { session_id: sessionId, subscription_id: attached.subscriptionId })).catch(() => undefined);
          rpc.close();
        }
      }
    },
  });

  return {
    id: HERMES_DOOR,
    async preflight(target: DoorTarget, signal: AbortSignal): Promise<Preflight> {
      const fault = await io.fault(path);
      if (fault?.kind === "missing") return { ok: false, why: "no Hermes gateway is running", absent: true };
      if (fault !== null) return { ok: false, why: `the control socket: ${describeFault(fault)}` };
      let answer: JsonValue;
      try {
        answer = await io.control(path, { protocol: 1, verb: "identify", id: 1 }, AbortSignal.any([signal, AbortSignal.timeout(CONTROL_MS)]));
      } catch (err) {
        if (err instanceof GatewayGone) return { ok: false, why: "no Hermes gateway is running", absent: true };
        return { ok: false, why: `identify: ${err instanceof Error ? err.message : String(err)}` };
      }
      const identified = readIdentify(answer, deps.home);
      if (!identified.ok) return identified;
      const binding = await deps.bind(target, signal);
      if (!binding.ok) return { ok: false, why: binding.why };
      if (!isHermesSessionId(binding.sessionId)) return { ok: false, why: "the pane's Hermes session id is not one Hermes writes" };
      return { ok: true, door: bound(identified.endpoint, binding.sessionId) };
    },
  };
}

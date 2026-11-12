// Hermes's door against a fake gateway: a real control socket and a real WebSocket on loopback. The four
// rules ADR 0142 names are pinned here: a non-loopback `api_origin` is never dialled, a path the walk
// refuses is never written to, the door calls only resume, submit, receipt and detach, and every send is
// one connection closed with 1000. Around them, the seam's rules (ADR 0141 point 2, SPEC V25): no gateway
// is absent, a failure before the submit frame refuses, a loss after it is uncertain.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "../json.ts";
import type { SocketFault } from "../mux/durable/client.ts";
import { tryDoor, type DoorSend, type Preflight } from "./door.ts";
import { DOOR_METHODS, GATEWAY_PROTOCOL, hermesDoor, SYSTEM_GATEWAY_IO, type GatewayIo, type HermesBinding } from "./hermes.ts";
import { gatewayUrl } from "./hermes-wire.ts";

const DIRS: string[] = [];
afterAll(() => {
  for (const dir of DIRS) rmSync(dir, { recursive: true, force: true });
});

const SESSION = `local-${"a".repeat(64)}`;
const TARGET = { session: "main", paneId: "w1:p1", harness: "hermes" };
const SEND: DoorSend = { requestId: "req_door_hermes_0001", text: "door one" };
const never = new AbortController().signal;

type Answer = { result: JsonValue } | { error: { code: number; message: string } };

/** A JSON-RPC frame from the door, as the fake reads it. */
interface DoorFrame {
  readonly jsonrpc?: string;
  readonly id?: number | string;
  readonly error?: JsonObject;
  readonly method?: string;
  readonly params?: JsonObject;
}

/** A control-socket request, as the fake reads it. */
interface ControlRequest {
  readonly verb: string;
  readonly params?: JsonObject;
}

/** What the fake gateway answers. Every field has the good answer as its default. */
interface Script {
  /** Fields laid over the good `identify` result. */
  identify?: JsonObject;
  /** The home the gateway says it serves; the test's own by default. */
  serves?: string;
  ticket?: JsonValue;
  protocol?: string;
  ready?: boolean;
  resume?: (params: JsonObject) => Answer;
  submit?: ((params: JsonObject) => Answer) | "drop" | "hang";
  /** A request the gateway sends the door right after `gateway.ready`. */
  serverRequest?: boolean;
}

/** What the fake gateway saw. */
interface Seen {
  verbs: string[];
  tickets: (JsonObject | undefined)[];
  upgrades: { origin: string | null; protocols: string | null }[];
  methods: string[];
  params: Record<string, JsonObject | undefined>;
  replies: DoorFrame[];
  closes: number[];
}

const identifyAnswer = (home: string, port: number, over: JsonObject = {}): JsonObject => ({
  ok: true,
  protocol: 1,
  id: 1,
  result: {
    runtime_protocol: 1,
    state: "ready",
    capabilities: ["session-authority-v1"],
    instance_id: "inst-1",
    authority_epoch: 3,
    api_origin: `http://127.0.0.1:${String(port)}`,
    served_profiles: [{ profile_id: home, home }],
    ...over,
  },
});

const goodResume = (params: JsonObject): Answer => ({
  result: { session_id: params.session_id ?? null, subscription_id: "sub-1", running: false, pending: [], prompts: [] },
});
const goodSubmit = (): Answer => ({ result: { admission_id: "adm-1", sequence: 5, status: "queued", outcome: null } });

interface FakeGateway {
  readonly home: string;
  readonly seen: Seen;
  stop(): void;
}

const running: FakeGateway[] = [];
afterEach(() => {
  for (const fake of running.splice(0)) fake.stop();
});

/** A fake gateway: a control socket at `<home>/gateway.sock` and a WebSocket server on 127.0.0.1. */
function fakeGateway(script: Script = {}, listen = true): FakeGateway {
  const home = mkdtempSync(join(tmpdir(), "hd-"));
  DIRS.push(home);
  const seen: Seen = { verbs: [], tickets: [], upgrades: [], methods: [], params: {}, replies: [], closes: [] };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      seen.upgrades.push({ origin: request.headers.get("origin"), protocols: request.headers.get("sec-websocket-protocol") });
      if (srv.upgrade(request, { headers: { "Sec-WebSocket-Protocol": script.protocol ?? GATEWAY_PROTOCOL } })) return undefined;
      return new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        if (script.ready !== false) ws.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: {} } }));
        if (script.serverRequest === true) ws.send(JSON.stringify({ jsonrpc: "2.0", id: "srv-1", method: "approval.request", params: {} }));
      },
      message(ws, data) {
        const frame: DoorFrame = JSON.parse(String(data));
        if (frame.method === undefined) {
          seen.replies.push(frame);
          return;
        }
        seen.methods.push(frame.method);
        const params = frame.params ?? {};
        seen.params[frame.method] = params;
        let answer: Answer;
        if (frame.method === "session.resume") answer = (script.resume ?? goodResume)(params);
        else if (frame.method === "prompt.submit") {
          const submit = script.submit ?? goodSubmit;
          if (submit === "drop") return ws.close(1011, "gone");
          if (submit === "hang") return;
          answer = submit(params);
        } else answer = { result: {} };
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...answer }));
      },
      close(_ws, code) {
        seen.closes.push(code);
      },
    },
  });
  const port = server.port ?? 0;
  const control = listen
    ? Bun.listen({
        unix: join(home, "gateway.sock"),
        socket: {
          data(sock, chunk) {
            const request: ControlRequest = JSON.parse(chunk.toString());
            seen.verbs.push(request.verb);
            let answer: JsonValue;
            if (request.verb === "identify") answer = identifyAnswer(script.serves ?? home, port, script.identify);
            else {
              seen.tickets.push(request.params);
              answer = script.ticket ?? { ok: true, id: 1, result: { ticket: "tkt-1", instance_id: "inst-1", profile_id: home, runtime_protocol: 1 } };
            }
            sock.write(`${JSON.stringify(answer)}\n`);
            sock.end();
          },
        },
      })
    : undefined;
  const fake: FakeGateway = {
    home,
    seen,
    stop: () => {
      control?.stop(true);
      void server.stop(true);
    },
  };
  running.push(fake);
  return fake;
}

/** The real control socket and WebSocket; the walk is the test's, since tmp sits under a link on macOS. */
const ioWith = (fault: SocketFault | null = null): GatewayIo => ({ ...SYSTEM_GATEWAY_IO, fault: () => Promise.resolve(fault) });
const bindTo =
  (binding: HermesBinding = { ok: true, sessionId: SESSION }) =>
  (): Promise<HermesBinding> =>
    Promise.resolve(binding);

const doorOn = (fake: FakeGateway, opts: { fault?: SocketFault | null; binding?: HermesBinding } = {}) =>
  hermesDoor({ home: fake.home, bind: bindTo(opts.binding), io: ioWith(opts.fault ?? null) });

async function send(fake: FakeGateway, opts: { binding?: HermesBinding } = {}, budgetMs = 3000) {
  const result = await tryDoor(doorOn(fake, opts), TARGET, SEND, budgetMs);
  // The detach and close finish after the answer; let the fake see them.
  await Bun.sleep(30);
  return result;
}

const why = (preflight: Preflight): string => (preflight.ok ? "bound" : preflight.why);

describe("preflight: absent or refused (SPEC V25, ADR 0142 points 1 and 6)", () => {
  test("no socket at the home is no gateway: absent, nothing asked", async () => {
    const fake = fakeGateway();
    const preflight = await doorOn(fake, { fault: { kind: "missing" } }).preflight(TARGET, never);
    expect(preflight).toEqual({ ok: false, why: "no Hermes gateway is running", absent: true });
    expect(fake.seen.verbs).toEqual([]);
  });

  test("a socket nobody listens on is no gateway: absent", async () => {
    const fake = fakeGateway({}, false);
    expect(await doorOn(fake).preflight(TARGET, never)).toEqual({ ok: false, why: "no Hermes gateway is running", absent: true });
  });

  test("a socket file a killed gateway left behind is no gateway: absent", async () => {
    const home = mkdtempSync(join(tmpdir(), "hd-"));
    const path = join(home, "gateway.sock");
    // A process killed while it listens never unlinks its socket: the file stays and nobody accepts.
    const gateway = Bun.spawn([process.execPath, "-e", `Bun.listen({ unix: ${JSON.stringify(path)}, socket: { data() {} } }); console.log("up");`], { stdout: "pipe" });
    await gateway.stdout.getReader().read();
    gateway.kill(9);
    await gateway.exited;
    expect(existsSync(path)).toBe(true);
    const door = hermesDoor({ home, bind: bindTo(), io: ioWith() });
    expect(await door.preflight(TARGET, never)).toEqual({ ok: false, why: "no Hermes gateway is running", absent: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("a link or an open folder on the socket's path refuses, and nothing is written to it", async () => {
    for (const fault of [{ kind: "symlink", path: "/home/u/.hermes" }, { kind: "ancestor-open-mode", path: "/home/u/.hermes", mode: 0o775 }] as const) {
      const fake = fakeGateway();
      const preflight = await doorOn(fake, { fault }).preflight(TARGET, never);
      expect(preflight.ok).toBe(false);
      expect("absent" in preflight).toBe(false);
      expect(fake.seen.verbs).toEqual([]);
    }
  });

  test("a gateway with no session authority is absent; one that is draining refuses", async () => {
    const old = fakeGateway({ identify: { capabilities: [] } });
    expect(await doorOn(old).preflight(TARGET, never)).toEqual({ ok: false, why: "the Hermes gateway has no session authority", absent: true });
    const v2 = fakeGateway({ identify: { runtime_protocol: 2 } });
    expect(await doorOn(v2).preflight(TARGET, never)).toEqual({ ok: false, why: "the Hermes gateway has no session authority", absent: true });
    const draining = fakeGateway({ identify: { state: "draining" } });
    expect(await doorOn(draining).preflight(TARGET, never)).toEqual({ ok: false, why: "the Hermes gateway is draining" });
  });

  test("a gateway that serves another home refuses", async () => {
    const fake = fakeGateway({ serves: "/home/other/.hermes" });
    expect(why(await doorOn(fake).preflight(TARGET, never))).toBe("the Hermes gateway does not serve this home");
  });

  test("a non-loopback api_origin refuses, and the WebSocket is never dialled (ADR 0142 point 3)", async () => {
    for (const origin of ["http://localhost:8642", "http://10.0.0.5:8642", "http://127.0.0.2:8642", "https://127.0.0.1:8642", "http://127.0.0.1:8642/x", "http://127.0.0.1"]) {
      const fake = fakeGateway({ identify: { api_origin: origin } });
      expect(await send(fake)).toEqual({ kind: "refused", why: "the Hermes gateway is not on loopback" });
      expect(fake.seen.upgrades).toEqual([]);
      expect(fake.seen.verbs).toEqual(["identify"]);
    }
  });

  test("the pane the binding cannot name refuses, with no ticket minted (SPEC V16)", async () => {
    const fake = fakeGateway();
    const result = await send(fake, { binding: { ok: false, why: "Which Hermes session is this pane showing? Nothing was sent." } });
    expect(result).toEqual({ kind: "refused", why: "Which Hermes session is this pane showing? Nothing was sent." });
    expect(fake.seen.verbs).toEqual(["identify"]);
  });

  test("a bound session id Hermes never writes refuses before it reaches the wire", async () => {
    const fake = fakeGateway();
    expect((await send(fake, { binding: { ok: true, sessionId: "../../etc" } })).kind).toBe("refused");
    expect(fake.seen.upgrades).toEqual([]);
  });
});

describe("gatewayUrl", () => {
  test("only plain http on a loopback literal with a port", () => {
    expect(gatewayUrl("http://127.0.0.1:8642")).toBe("ws://127.0.0.1:8642/api/ws");
    expect(gatewayUrl("http://127.0.0.1:8642/")).toBe("ws://127.0.0.1:8642/api/ws");
    expect(gatewayUrl("http://[::1]:8642")).toBe("ws://[::1]:8642/api/ws");
    for (const bad of ["http://localhost:1", "http://u:p@127.0.0.1:1", "http://127.0.0.1:1?x=1", "ws://127.0.0.1:1", "not a url"]) {
      expect(gatewayUrl(bad)).toBeNull();
    }
  });
});

describe("submit", () => {
  test("an idle session takes the send: one connection, the four methods at most, closed with 1000 (ADR 0142 points 4 and 5)", async () => {
    const fake = fakeGateway();
    expect(await send(fake)).toEqual({ kind: "submitted", answer: { kind: "taken" } });
    expect(fake.seen.verbs).toEqual(["identify", "session-ticket"]);
    expect(fake.seen.tickets).toEqual([{ profile_id: fake.home, instance_id: "inst-1", purpose: "interactive" }]);
    expect(fake.seen.upgrades).toEqual([{ origin: null, protocols: `${GATEWAY_PROTOCOL}, hermes-gateway-ticket.tkt-1` }]);
    expect(fake.seen.methods).toEqual(["session.resume", "prompt.submit", "session.detach"]);
    const allowed: readonly string[] = DOOR_METHODS;
    expect(fake.seen.methods.every((method) => allowed.includes(method))).toBe(true);
    expect(fake.seen.params["session.resume"]).toEqual({ session_id: SESSION });
    expect(fake.seen.params["prompt.submit"]).toEqual({ session_id: SESSION, text: "door one", input_id: "collie-req_door_hermes_0001" });
    expect(fake.seen.params["session.detach"]).toEqual({ session_id: SESSION, subscription_id: "sub-1" });
    expect(fake.seen.closes).toEqual([1000]);
  });

  test("a busy session queues the send as its own turn (SPEC V13)", async () => {
    const busy: JsonObject[] = [{ running: true }, { pending: [{ input_id: "b11eb661", status: "queued" }] }, { prompts: [{}] }];
    for (const over of busy) {
      const fake = fakeGateway({ resume: (params) => ({ result: { running: false, pending: [], prompts: [], ...over, session_id: params.session_id ?? null, subscription_id: "sub-1" } }) });
      expect(await send(fake)).toEqual({ kind: "submitted", answer: { kind: "queued" } });
    }
  });

  test("the same request id again is a replay (SPEC V12)", async () => {
    const done = fakeGateway({ submit: () => ({ result: { admission_id: "adm-1", status: "terminal", outcome: "completed" } }) });
    expect(await send(done)).toEqual({ kind: "submitted", answer: { kind: "replayed" } });
    const waiting = fakeGateway({
      resume: (params) => ({ result: { session_id: params.session_id ?? null, subscription_id: "sub-1", running: true, pending: [{ input_id: "collie-req_door_hermes_0001" }] } }),
    });
    expect(await send(waiting)).toEqual({ kind: "submitted", answer: { kind: "replayed" } });
  });

  test("the gateway's own error to the submit refuses (an id admitted with other text, SPEC V12), and the door still leaves", async () => {
    const fake = fakeGateway({ submit: () => ({ error: { code: 4009, message: "admission_conflict" } }) });
    expect(await send(fake)).toEqual({ kind: "refused", why: "prompt.submit: admission_conflict" });
    expect(fake.seen.methods).toEqual(["session.resume", "prompt.submit", "session.detach"]);
    expect(fake.seen.closes).toEqual([1000]);
  });

  test("a failure before the submit frame refuses, and no prompt.submit is sent", async () => {
    const denied = fakeGateway({ resume: () => ({ error: { code: 4003, message: "permission_denied" } }) });
    expect(await send(denied)).toEqual({ kind: "refused", why: "session.resume: permission_denied" });
    expect(denied.seen.methods).toEqual(["session.resume"]);

    const other = fakeGateway({ resume: () => ({ result: { session_id: `local-${"b".repeat(64)}`, subscription_id: "sub-2" } }) });
    expect(await send(other)).toEqual({ kind: "refused", why: "the gateway attached another session" });
    expect(other.seen.methods).not.toContain("prompt.submit");

    const noTicket = fakeGateway({ ticket: { ok: false, error: "peer_uid_mismatch" } });
    expect(await send(noTicket)).toEqual({ kind: "refused", why: "the gateway minted no ticket" });
    expect(noTicket.seen.upgrades).toEqual([]);

    const notReady = fakeGateway({ ready: false });
    expect((await send(notReady)).kind).toBe("refused");
    expect(notReady.seen.methods).toEqual([]);
    expect(notReady.seen.closes).toEqual([1000]);
  });

  test("a connection lost after the submit frame is uncertain, never a refusal (ADR 0141 point 2)", async () => {
    const dropped = fakeGateway({ submit: "drop" });
    expect((await send(dropped)).kind).toBe("uncertain");
    const hung = fakeGateway({ submit: "hang" });
    expect((await send(hung, {}, 600)).kind).toBe("uncertain");
    // The budget's end closes the connection, so a hung gateway is not held open.
    await Bun.sleep(100);
    expect(hung.seen.closes).toEqual([1000]);
  });

  test("a request from the gateway is answered 'method not found', and the door calls nothing more", async () => {
    const fake = fakeGateway({ serverRequest: true });
    expect(await send(fake)).toEqual({ kind: "submitted", answer: { kind: "taken" } });
    expect(fake.seen.replies).toEqual([{ jsonrpc: "2.0", id: "srv-1", error: { code: -32601, message: "method not found" } }]);
    expect(fake.seen.methods).toEqual(["session.resume", "prompt.submit", "session.detach"]);
  });

  test("a throw while dialling, before any frame, refuses: nothing was sent (ADR 0141 point 2)", async () => {
    const fake = fakeGateway();
    const io: GatewayIo = {
      ...ioWith(),
      dial: () => {
        throw new SyntaxError("invalid subprotocol");
      },
    };
    const result = await tryDoor(hermesDoor({ home: fake.home, bind: bindTo(), io }), TARGET, SEND, 3000);
    expect(result).toEqual({ kind: "refused", why: "before the submit: invalid subprotocol" });
    expect(fake.seen.upgrades).toEqual([]);
    expect(fake.seen.methods).toEqual([]);
  });

  test("the walk runs again before the ticket: a socket swapped since preflight refuses with no write", async () => {
    const fake = fakeGateway();
    let calls = 0;
    const io: GatewayIo = { ...SYSTEM_GATEWAY_IO, fault: () => Promise.resolve(++calls === 1 ? null : { kind: "symlink", path: join(fake.home, "gateway.sock") }) };
    const result = await tryDoor(hermesDoor({ home: fake.home, bind: bindTo(), io }), TARGET, SEND, 3000);
    expect(result.kind).toBe("refused");
    expect(fake.seen.verbs).toEqual(["identify"]);
  });
});

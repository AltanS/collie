// A fake inside part (M99 spec 01): speaks wire v1 over the real socket, for this spec's tests and every
// later one (send by data, asks, WalkyTalky). It does what a real part does on the wire and nothing a
// harness does: it says hello, posts events, long-polls for commands and answers them as told.
//
// Not a test double of the bridge: it dials a real `InsideServer`. Beside it, `fakeEdgeTarget` and
// `fakeLiveness` stand for one terminal session and the pid probe, so a test runs the real placement.
// Nothing in the bridge imports this file.

import { asJsonString, parseJsonObject, type JsonObject, type JsonValue } from "../../web/src/lib/json.ts";
import type { BeaconMatcher } from "../beacon/decorate.ts";
import type { BeaconLiveness } from "../beacon/reader.ts";
import type { EdgeTarget } from "../surface/edges.ts";
import { parseCommand, WIRE_ROUTES, WIRE_VERSION, type WireCommand } from "./wire.ts";

/** A raw wire answer: the status and the JSON body, or null for an empty one. */
export interface FakeAnswer {
  readonly status: number;
  readonly body: JsonObject | null;
}

export class FakePart {
  /** The part id the bridge minted at the last hello that said "mine". */
  partId: string | null = null;

  /** `hello` overrides any field of the default hello: a test passes only what it changes. */
  constructor(
    private readonly socketPath: string,
    private readonly helloFields: JsonObject = {},
  ) {}

  /** One request on the socket, with a raw text body. */
  async requestText(method: "GET" | "POST", path: string, text: string | null, signal?: AbortSignal): Promise<FakeAnswer> {
    const init: RequestInit & { unix: string } = { method, unix: this.socketPath, signal };
    if (text !== null) {
      init.headers = { "content-type": "application/json" };
      init.body = text;
    }
    const response = await fetch(`http://inside${path}`, init);
    const reply = await response.text();
    return { status: response.status, body: reply === "" ? null : (parseJsonObject(reply) ?? null) };
  }

  /** One request on the socket, with a JSON body. */
  request(method: "GET" | "POST", path: string, body?: JsonValue, signal?: AbortSignal): Promise<FakeAnswer> {
    return this.requestText(method, path, body === undefined ? null : JSON.stringify(body), signal);
  }

  /** The hello this part sends. */
  helloBody(): JsonObject {
    return {
      wire: WIRE_VERSION,
      harness: "fake",
      harnessVersion: "0.0.1",
      partVersion: "0.0.1",
      session: "fake-session",
      cwd: "/tmp",
      pid: process.pid,
      pidStartTime: null,
      env: {},
      capabilities: ["send", "mail", "draft", "draft.state", "wake"],
      asks: ["permission"],
      ...this.helloFields,
    };
  }

  /** Say hello. Keeps the part id when the bridge says "mine". */
  async hello(): Promise<FakeAnswer> {
    const answer = await this.request("POST", WIRE_ROUTES.hello, this.helloBody());
    const part = asJsonString(answer.body?.part);
    if (answer.status === 200 && answer.body?.mine === true && part !== undefined) this.partId = part;
    return answer;
  }

  /** Post one event of this part. */
  event(kind: string, fields: JsonObject = {}): Promise<FakeAnswer> {
    return this.request("POST", WIRE_ROUTES.event, { part: this.partId, kind, ...fields });
  }

  /** One long poll. `ask` waits for that ask's answer only. A 200 body is parsed as a command. */
  async next(options: { ask?: string; waitMs?: number; signal?: AbortSignal } = {}): Promise<{ status: number; command: WireCommand | null }> {
    const query = new URLSearchParams({ part: this.partId ?? "" });
    if (options.ask !== undefined) query.set("ask", options.ask);
    if (options.waitMs !== undefined) query.set("wait", String(options.waitMs));
    const answer = await this.request("GET", `${WIRE_ROUTES.next}?${query.toString()}`, undefined, options.signal);
    if (answer.status !== 200 || answer.body === null) return { status: answer.status, command: null };
    const command = parseCommand(JSON.stringify(answer.body));
    if ("ok" in command) throw new Error(`the bridge sent a bad command: ${command.error}`);
    return { status: answer.status, command };
  }

  /**
   * Poll once and act as a well-behaved part: confirm the handoff with `taken`, then report `sent`, or
   * `failed` with `failReason` when given (and `failDetail`, the part's own words, when given too). A
   * `draft` question is answered with `draftText`.
   */
  async serveOnce(options: { waitMs?: number; failReason?: string; failDetail?: string; draftText?: string; silent?: boolean } = {}): Promise<WireCommand | null> {
    const { command } = await this.next({ waitMs: options.waitMs ?? 1000 });
    if (command === null || options.silent === true) return command;
    await this.event("taken", { cmd: command.id });
    if (command.kind === "draft") {
      const text = options.draftText ?? "";
      await this.event("draft", { cmd: command.id, text, caret: text.length });
      return command;
    }
    if (options.failReason !== undefined) await this.event("failed", options.failDetail === undefined ? { cmd: command.id, reason: options.failReason } : { cmd: command.id, reason: options.failReason, detail: options.failDetail });
    else await this.event("sent", { cmd: command.id });
    return command;
  }

  /** Say goodbye. */
  bye(): Promise<FakeAnswer> {
    return this.event("bye");
  }
}

/** A marker matcher over one scope: a marker names a pane when its scope and its raw pane id match. */
export function fakeMatcher(namespace: string, scope: string): BeaconMatcher {
  return {
    namespace,
    scope: () => Promise.resolve(scope),
    matches: (pane, marker, seen) => marker.scope === seen && marker.pane === pane.paneId,
    notesWithoutHooks: { agentDetection: "", agentSessionRef: "" },
  };
}

/** One terminal session for the placement: its panes, and the foreground pids when the test gives them. */
export function fakeEdgeTarget(options: { session: string; panes: readonly string[]; namespace?: string; scope?: string; foreground?: readonly number[] }): EdgeTarget {
  const target: EdgeTarget = {
    session: options.session,
    matcher: fakeMatcher(options.namespace ?? "herdr", options.scope ?? "/run/herdr.sock"),
    paneIds: () => options.panes,
    deliver: () => {},
  };
  const pids = options.foreground;
  if (pids === undefined) return target;
  return { ...target, foreground: () => Promise.resolve({ ok: true as const, value: pids.map((pid) => ({ argv: ["agent"], pid })) }) };
}

/** A pid probe that knows the given pids and their start times, and no others. */
export function fakeLiveness(starts: ReadonlyMap<number, number>): BeaconLiveness {
  return { startTimeOf: (pid) => Promise.resolve(starts.get(pid) ?? null) };
}

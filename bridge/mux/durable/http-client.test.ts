import { afterEach, describe, expect, test } from "bun:test";

import type { ControlRequest } from "../../types.ts";
import type { MuxOutcome, MuxSnapshot } from "../types.ts";
import { createDurableMux, DURABLE_BUDGETS, describeDurableTarget, DurableMux, MIN_SNAPSHOT_GAP_MS, STARTER_TIMEOUT_MS } from "./adapter.ts";
import { DurableOutcomeUnknown, DurableSocketClient, DurableUnreachable, type DurableGet, type DurablePost, type DurableReply, type DurableTransport } from "./client.ts";
import type { DurableEventSink } from "./events.ts";
import { FakeDurableClock, FakeDurableProgram, helloFixture, snapshotFixture, SOCKET_ONLY_SKIP, testToken } from "./fixture.ts";
import { DURABLE_TOKEN_ENV, DURABLE_URL_ENV, DurableHttpClient, strongEtag, TOKEN_REFUSED } from "./http-client.ts";
import type { DurableEvent } from "./protocol.ts";
import { DurableWatch, type WatchClock, type WatchTimer } from "./watch.ts";

// THE SECOND TRANSPORT (WIRE.md section 1B, ADR 0103): the same wire over HTTP with a bearer token,
// against the fake program served by `Bun.serve` on 127.0.0.1. Every token here is minted at run
// time by `testToken()` and never written to a file, and the fake records only whether the header
// matched, so no test output can carry one.

const programs: FakeDurableProgram[] = [];
afterEach(async () => {
  for (const program of programs.splice(0)) await program.close();
});

async function startProgram(token: string): Promise<FakeDurableProgram> {
  const program = await FakeDurableProgram.startHttp(token);
  programs.push(program);
  return program;
}

/** A URL on 127.0.0.1 where nothing listens: a port that was free a moment ago. */
async function closedUrl(): Promise<string> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port ?? 0;
  await probe.stop(true);
  return `http://127.0.0.1:${String(port)}`;
}

const hello: DurableGet = { path: "/hello", version: null, ifNoneMatch: null, timeoutMs: 1000, maxBytes: 16 * 1024 };

/** The rejection of a promise, so a test can read its detail. */
async function refusal(promise: Promise<unknown>): Promise<DurableUnreachable> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof DurableUnreachable) return err;
    throw err;
  }
  throw new Error("the call answered");
}

function verdict(outcome: MuxOutcome<MuxSnapshot>): string {
  return outcome.ok ? "ok" : `${outcome.reason}: ${outcome.detail}`;
}

/** A sink that remembers which panes got events. */
class RecordingSink implements DurableEventSink {
  readonly panes: string[] = [];
  apply(paneId: string, events: readonly DurableEvent[]): Promise<number> {
    this.panes.push(paneId);
    return Promise.resolve(events.length);
  }
}

/** A transport that answers nothing and records the budgets the adapter asked for. */
class BudgetRecorder implements DurableTransport {
  readonly kind = "https";
  readonly timeouts: number[] = [];
  get(request: DurableGet): Promise<DurableReply> {
    this.timeouts.push(request.timeoutMs);
    return Promise.reject(new DurableUnreachable("connection refused"));
  }
  post(request: DurablePost): Promise<DurableReply> {
    this.timeouts.push(request.timeoutMs);
    return Promise.reject(new DurableUnreachable("connection refused"));
  }
}

const UUID = ["0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b61", "0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b62", "0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b63", "0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b64"] as const;

describe("the http transport: the request", () => {
  test("the bearer header goes on every request, read and write, over http", async () => {
    const token = testToken();
    const program = await startProgram(token);
    const clock = new FakeDurableClock();
    const adapter = new DurableMux(new DurableHttpClient(program.url, token), clock, new RecordingSink());
    expect((await adapter.poll()).ok).toBe(true);
    program.appendEvent("conv-01", { type: "item", item: { id: "i1", kind: "reply", text: "hi" } });
    clock.advance(MIN_SNAPSHOT_GAP_MS + 50);
    await adapter.poll();
    await adapter.syncEvents();
    await adapter.answerAsk("conv-02", { requestId: UUID[0], askId: "ask-6f1d0c2a8b3e4d57a9c01e2b3d4f5a6c", revision: 1, optionId: "allow" });
    await adapter.controlTurn("conv-03", { act: "send", requestId: UUID[1], target: { kind: "turn", id: "turn-03-c" }, text: "go on", steer: false });
    await adapter.startStarter("notes-new", UUID[2]);
    const routes = new Set(program.requests.map((request) => `${request.method} ${request.path.replace(/\/pane\/[^/]+/u, "/pane/:id")}`));
    for (const route of ["GET /session/v1/hello", "GET /session/v1/snapshot", "GET /session/v1/pane/:id/events", "POST /session/v1/pane/:id/answer", "POST /session/v1/pane/:id/send", "POST /session/v1/starter/notes-new"]) {
      expect(routes.has(route)).toBe(true);
    }
    expect(program.requests.every((request) => request.bearer === "match")).toBe(true);
  });

  // Socket only: it is the socket client under test.
  test.skipIf(SOCKET_ONLY_SKIP)("the socket client never sends an Authorization header (http check of the other transport)", async () => {
    const program = await FakeDurableProgram.start();
    programs.push(program);
    const adapter = new DurableMux(new DurableSocketClient(program.socketPath), new FakeDurableClock());
    expect((await adapter.poll()).ok).toBe(true);
    expect(program.requests.every((request) => request.bearer === "none")).toBe(true);
  });

  test("a 3xx from the program over http is passed up as a status and never followed", async () => {
    const token = testToken();
    const program = await startProgram(token);
    program.override = () => new Response(null, { status: 302, headers: { location: "https://elsewhere.invalid/" } });
    const reply = await new DurableHttpClient(program.url, token).get(hello);
    expect(reply.status).toBe(302);
    expect(program.requests).toHaveLength(1);
  });

  test("the client keeps an optional path prefix and adds /session/v1 after it (http)", async () => {
    const token = testToken();
    const program = await startProgram(token);
    const reply = await new DurableHttpClient(`${program.url}/collie`, token).get(hello);
    expect(reply.status).toBe(404);
    expect(program.requests[0]?.path).toBe("/collie/session/v1/hello");
  });
});

describe("the http transport: hello", () => {
  test("hello runs unchanged over http, and a server without the service name is refused by name", async () => {
    const token = testToken();
    const program = await startProgram(token);
    program.hello.service = undefined;
    const adapter = new DurableMux(new DurableHttpClient(program.url, token), new FakeDurableClock());
    expect(verdict(await adapter.poll())).toBe("unreachable: incompatible: not a durable agent");
  });

  test("a version range that does not meet is incompatible over http, as on the socket", async () => {
    const token = testToken();
    const program = await startProgram(token);
    program.range = { min: 2, max: 3 };
    const adapter = new DurableMux(new DurableHttpClient(program.url, token), new FakeDurableClock(), null, () => {});
    expect(verdict(await adapter.poll())).toBe("unreachable: incompatible: the durable agent speaks 2..3, this Collie speaks 1..1");
  });
});

describe("the http transport: a refused token", () => {
  test("a 401 before hello is unreachable with token-refused, and the program is asked once per down-gap, not per caller (http)", async () => {
    const program = await startProgram(testToken());
    const clock = new FakeDurableClock();
    const adapter = new DurableMux(new DurableHttpClient(program.url, testToken()), clock);
    expect(verdict(await adapter.poll())).toBe(`unreachable: ${TOKEN_REFUSED}: the durable agent answered 401`);
    expect(program.requests).toHaveLength(1);
    // The bridge's fast poll is 1.5 s while the watch is down. Inside the 10 s down-gap every caller
    // gets the same answer, and nothing is sent.
    for (let i = 0; i < 6; i += 1) {
      clock.advance(1500);
      expect(verdict(await adapter.poll())).toBe(`unreachable: ${TOKEN_REFUSED}: the durable agent answered 401`);
    }
    expect(program.requests).toHaveLength(1);
    clock.advance(DURABLE_BUDGETS.https.downGapMs);
    await adapter.poll();
    expect(program.requests).toHaveLength(2);
    expect(program.requests.every((request) => request.bearer === "other" && request.path === "/session/v1/hello")).toBe(true);
  });

  test("a token that stops working keeps the last layout for one read, then flips: the socket's hysteresis (http)", async () => {
    const token = testToken();
    const program = await startProgram(token);
    const clock = new FakeDurableClock();
    const adapter = new DurableMux(new DurableHttpClient(program.url, token), clock);
    expect((await adapter.poll()).ok).toBe(true);
    program.rotateToken(testToken());
    // Each read one idle census apart: over https the watch is the only dialer, so a poll inside the
    // cadence would be served the last good read and never reach the program.
    clock.advance(DURABLE_BUDGETS.https.idlePollMs);
    expect((await adapter.poll()).ok).toBe(true);
    clock.advance(DURABLE_BUDGETS.https.idlePollMs);
    expect(verdict(await adapter.poll())).toBe(`unreachable: ${TOKEN_REFUSED}: the durable agent answered 401`);
  });

  test("a 403 is token-refused too, and a write with a refused token is unreachable: nothing ran (http)", async () => {
    const token = testToken();
    const program = await startProgram(token);
    const clock = new FakeDurableClock();
    const adapter = new DurableMux(new DurableHttpClient(program.url, token), clock);
    expect((await adapter.poll()).ok).toBe(true);
    program.override = () => new Response(JSON.stringify({ code: "forbidden" }), { status: 403 });
    const request: ControlRequest = { act: "abort", requestId: UUID[3], target: { kind: "turn", id: "turn-01-a" } };
    expect(await adapter.controlTurn("conv-01", request)).toEqual({ kind: "unreachable", detail: `${TOKEN_REFUSED}: the durable agent answered 403` });
    expect(program.aborts).toEqual([]);
  });
});

describe("the http transport: the ETag", () => {
  test("a weak ETag comes back strong, so the next If-None-Match is the program's own value and gets a 304 (http)", async () => {
    const token = testToken();
    const program = await startProgram(token);
    program.weakEtag = true;
    const client = new DurableHttpClient(program.url, token);
    const first = await client.get({ ...hello, path: "/snapshot", version: 1, maxBytes: 4 * 1024 * 1024 });
    expect(first.etag).toBe(`"${program.epoch}-${String(program.rev)}"`);
    const again = await client.get({ ...hello, path: "/snapshot", version: 1, ifNoneMatch: first.etag });
    expect(again.status).toBe(304);
    expect(program.requests[1]?.ifNoneMatch).toBe(first.etag);
    // The program side of the rule: a weak If-None-Match compares equal with W/ stripped.
    const weak = await client.get({ ...hello, path: "/snapshot", version: 1, ifNoneMatch: `W/${first.etag ?? ""}` });
    expect(weak.status).toBe(304);
  });

  test("the adapter's second read over http is a 304 behind a weakening proxy", async () => {
    const token = testToken();
    const program = await startProgram(token);
    program.weakEtag = true;
    const clock = new FakeDurableClock();
    const adapter = new DurableMux(new DurableHttpClient(program.url, token), clock);
    expect((await adapter.poll()).ok).toBe(true);
    clock.advance(MIN_SNAPSHOT_GAP_MS + 50);
    await adapter.refresh(); // a look: past the floor it reads, as the watch's census does
    const snapshots = program.requests.filter((request) => request.path.endsWith("/snapshot"));
    expect(snapshots.map((request) => request.ifNoneMatch)).toEqual([null, `"${program.epoch}-${String(program.rev)}"`]);
  });

  test("strongEtag strips W/ and leaves a strong tag alone (http)", () => {
    expect(strongEtag('W/"e-1"')).toBe('"e-1"');
    expect(strongEtag('"e-1"')).toBe('"e-1"');
    expect(strongEtag(null)).toBeNull();
  });
});

describe("the http transport: budgets and timeouts", () => {
  test("over http a read and a write get 5000 ms, a starter keeps its 30 s", async () => {
    const recorder = new BudgetRecorder();
    const adapter = new DurableMux(recorder, new FakeDurableClock());
    expect(adapter.budget).toBe(DURABLE_BUDGETS.https);
    await adapter.poll();
    expect(recorder.timeouts).toEqual([5000]);
    expect(DURABLE_BUDGETS.https).toMatchObject({ readTimeoutMs: 5000, writeTimeoutMs: 5000, watchedPollMs: 2000, idlePollMs: 10_000 });
    expect(DURABLE_BUDGETS.socket).toMatchObject({ readTimeoutMs: 1000, writeTimeoutMs: 3000, watchedPollMs: 1000, idlePollMs: 3000 });
    expect(STARTER_TIMEOUT_MS).toBe(30_000);
    expect(adapter.capabilities.topologyLatency).toEqual({ kind: "bounded", ms: 10_000 });
  });

  test("a program that does not answer in time over http is unreachable, and the call ends", async () => {
    const token = testToken();
    const program = await startProgram(token);
    program.override = () => new Promise<Response>(() => undefined);
    const started = Date.now();
    const err = await refusal(new DurableHttpClient(program.url, token).get({ ...hello, timeoutMs: 60 }));
    expect(err.detail).toBe("no answer within 60ms");
    expect(Date.now() - started).toBeLessThan(900);
  });

  test("a POST over http whose reply trickles past the deadline has an unknown outcome", async () => {
    const token = testToken();
    const program = await startProgram(token);
    program.override = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await Bun.sleep(20);
            controller.enqueue(new Uint8Array([0x20]));
          },
        }),
      );
    const posted = new DurableHttpClient(program.url, token).post({ path: "/pane/p/abort", version: 1, body: { requestId: "r" }, timeoutMs: 150, maxBytes: 16 * 1024 });
    await expect(posted).rejects.toBeInstanceOf(DurableOutcomeUnknown);
    await expect(posted).rejects.toMatchObject({ detail: "no answer within 150ms" });
  });

  test("nothing listening over http: a read is connection refused, and a POST never left", async () => {
    const client = new DurableHttpClient(await closedUrl(), testToken());
    expect((await refusal(client.get(hello))).detail).toBe("connection refused");
    await expect(client.post({ path: "/pane/p/abort", version: 1, body: { requestId: "r" }, timeoutMs: 1000, maxBytes: 1024 })).rejects.toBeInstanceOf(DurableUnreachable);
  });

  test("a reply past the byte cap over http is cut off as too-large", async () => {
    const token = testToken();
    const program = await startProgram(token);
    program.override = () => new Response("x".repeat(20_000), { headers: { "content-type": "application/json" } });
    expect((await refusal(new DurableHttpClient(program.url, token).get(hello))).detail).toBe("too-large");
  });
});

describe("the http transport: the whole wire (Requirement 2)", () => {
  test("over http: hello, snapshot, events, answer, send, abort and starter all pass", async () => {
    const token = testToken();
    const program = await startProgram(token);
    const clock = new FakeDurableClock();
    const sink = new RecordingSink();
    const adapter = new DurableMux(new DurableHttpClient(program.url, token), clock, sink);
    const snapshot = await adapter.snapshot();
    expect(snapshot.panes.map((pane) => pane.paneId)).toEqual(["conv-01", "conv-02", "conv-03", "conv-04", "conv-05"]);

    program.appendEvent("conv-01", { type: "item", item: { id: "i1", kind: "reply", text: "hello" } });
    clock.advance(MIN_SNAPSHOT_GAP_MS + 50);
    await adapter.poll();
    expect(await adapter.syncEvents()).toContain("conv-01");

    const answered = await adapter.answerAsk("conv-02", { requestId: UUID[0], askId: "ask-6f1d0c2a8b3e4d57a9c01e2b3d4f5a6c", revision: 1, optionId: "allow" });
    expect(answered).toEqual({ ok: true, value: { kind: "taken", replayed: false } });
    expect(program.answers.map((answer) => answer.optionId)).toEqual(["allow"]);

    clock.advance(MIN_SNAPSHOT_GAP_MS + 50);
    const sent = await adapter.controlTurn("conv-03", { act: "send", requestId: UUID[1], target: { kind: "turn", id: "turn-03-c" }, text: "go on", steer: false });
    expect(sent).toEqual({ kind: "ok", replayed: false });
    expect(program.sends.map((one) => one.text)).toEqual(["go on"]);

    clock.advance(MIN_SNAPSHOT_GAP_MS + 50);
    const stopped = await adapter.controlTurn("conv-01", { act: "abort", requestId: UUID[2], target: { kind: "turn", id: "turn-01-a" } });
    expect(stopped).toEqual({ kind: "ok", replayed: false });
    expect(program.aborts).toHaveLength(1);

    clock.advance(MIN_SNAPSHOT_GAP_MS + 50);
    const started = await adapter.startStarter("notes-new", UUID[3]);
    expect(started).toMatchObject({ kind: "started", replayed: false });
    expect(program.starts).toHaveLength(1);
    expect(program.requests.every((request) => request.bearer === "match")).toBe(true);
  });
});

describe("the http transport: a peer that boots (Requirement 1)", () => {
  test("a peer with a loopback http URL and a token boots, says its transport, and is unreachable while nothing listens", async () => {
    const url = await closedUrl();
    const env = { COLLIE_MUX: "durable", [DURABLE_URL_ENV]: url, [DURABLE_TOKEN_ENV]: testToken() };
    expect(describeDurableTarget(env)).toBe(`loopback http (wrangler dev) ${url} with a bearer token (64 bytes)`);
    const adapter = createDurableMux(env, {});
    expect(adapter.budget).toBe(DURABLE_BUDGETS.https);
    expect(verdict(await adapter.poll())).toBe("unreachable: connection refused");
    expect(adapter.program()).toBeNull();
  });

  test("a broken pair boots too, and the boot line and every read say the same thing (http)", async () => {
    const env = { [DURABLE_URL_ENV]: "http://example.com:8801", [DURABLE_TOKEN_ENV]: testToken() };
    const line = describeDurableTarget(env);
    expect(line).toStartWith("not started: COLLIE_DURABLE_URL uses plain http to example.com");
    expect(verdict(await createDurableMux(env, {}).poll())).toBe(`unreachable: ${line.slice("not started: ".length)}`);
  });
});

// THE ONE FAILURE THAT MATTERS (spec Risk): a token in a log line. This boots a peer the way the
// bridge does (the boot line goes to the log), reads from a program that is not there, then from one
// that refuses the token, prints every outcome as the bridge's poll warning would, and asks doctor's
// own hello path through `Bun.inspect` of the client. Everything written to the console and to
// stdout and stderr in between is captured. The token must appear nowhere in it.
describe("the http transport: secrecy", () => {
  test("never logs the token: a boot, an unreachable read and a refused hello print no token", async () => {
    const token = testToken();
    const captured: string[] = [];
    const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    const keep = (...parts: unknown[]): void => {
      captured.push(parts.map((part) => Bun.inspect(part)).join(" "));
    };
    console.log = keep;
    console.warn = keep;
    console.error = keep;
    console.info = keep;
    console.debug = keep;
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(String(chunk));
      return true;
    };
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      captured.push(String(chunk));
      return true;
    };
    try {
      // Boot against nothing: the bridge logs the target line and the poll's failure.
      const nothing = { COLLIE_MUX: "durable", [DURABLE_URL_ENV]: await closedUrl(), [DURABLE_TOKEN_ENV]: `  ${token}  ` };
      console.log(`[collie] driving durable · ${describeDurableTarget(nothing)}`);
      const down = createDurableMux(nothing, {});
      const first = await down.poll();
      console.warn(`[collie] mux poll failed: ${verdict(first)}`);
      console.log(down);

      // A program that holds another token: the hello is refused.
      const program = await startProgram(testToken());
      const refusing = { COLLIE_MUX: "durable", [DURABLE_URL_ENV]: program.url, [DURABLE_TOKEN_ENV]: token };
      console.log(`[collie] driving durable · ${describeDurableTarget(refusing)}`);
      const refused = createDurableMux(refusing, {});
      const outcome = await refused.poll();
      console.warn(`[collie] mux poll failed: ${verdict(outcome)}`);
      expect(verdict(outcome)).toContain(TOKEN_REFUSED);
      const client = new DurableHttpClient(program.url, token);
      console.log(client, JSON.stringify(client));
      try {
        await client.get(hello);
      } catch (thrown) {
        console.error(thrown);
      }
      console.log(program.requests);

      // A token that breaks its rule is named by its byte count, never its value.
      const short = token.slice(0, 20);
      console.log(describeDurableTarget({ [DURABLE_URL_ENV]: program.url, [DURABLE_TOKEN_ENV]: short }));
      expect(captured.join("\n")).not.toContain(short);
    } finally {
      Object.assign(console, saved);
      process.stdout.write = out;
      process.stderr.write = err;
    }
    const text = captured.join("\n");
    expect(captured.length).toBeGreaterThan(5);
    expect(text).toContain("bearer token (64 bytes)");
    expect(text).not.toContain(token);
  });
});

// THE WATCH IS THE ONLY DIALER OVER HTTPS (M50 spec 14, decision 3). Every read there is a billed
// request, and the bridge polls the adapter on its own 12 s safety net beside the watch's census. On a
// fake clock, with the watch and the bridge's poll interleaved, the program must see one read per
// census and nothing from the bridge. `refresh()`, a person's look, still reads at once.

/** The bridge's relaxed safety-net poll (`COLLIE_POLL_IDLE_MS`, bridge/config.ts). */
const BRIDGE_POLL_MS = 12_000;

const BILLED_EPOCH = "b1f0c2d3e4a5968778695a4b3c2d1e0f";

/** An https program in memory. It answers at once and notes the fake clock's time of every snapshot read. */
class BilledProgram implements DurableTransport {
  readonly reads: number[] = [];
  constructor(
    private readonly clock: FakeDurableClock,
    readonly kind: "https" | "socket" = "https",
  ) {}
  get(request: DurableGet): Promise<DurableReply> {
    if (request.path === "/hello") {
      const doc = { ...helloFixture(), service: "collie-durable", protocol: { min: 1, max: 1 }, epoch: BILLED_EPOCH, ready: true };
      return Promise.resolve({ status: 200, etag: null, text: JSON.stringify(doc) });
    }
    this.reads.push(this.clock.now());
    const etag = `"${BILLED_EPOCH}-1"`;
    if (request.ifNoneMatch === etag) return Promise.resolve({ status: 304, etag, text: "" });
    return Promise.resolve({ status: 200, etag, text: JSON.stringify({ rev: 1, epoch: BILLED_EPOCH, ...snapshotFixture() }) });
  }
  post(_request: DurablePost): Promise<DurableReply> {
    return Promise.reject(new DurableUnreachable("no writes here"));
  }
}

/** The watch's one timer, on the fake clock: due times, fired when the clock reaches them. */
class FakeTimers implements WatchClock {
  private readonly due = new Map<WatchTimer, { readonly at: number; readonly fn: () => void }>();
  constructor(private readonly clock: FakeDurableClock) {}
  setTimeout(fn: () => void, ms: number): WatchTimer {
    const token = globalThis.setTimeout(() => undefined, 0);
    globalThis.clearTimeout(token);
    this.due.set(token, { at: this.clock.now() + ms, fn });
    return token;
  }
  clearTimeout(handle: WatchTimer): void {
    this.due.delete(handle);
  }
  next(): number {
    return Math.min(...[...this.due.values()].map((timer) => timer.at));
  }
  fireDue(): void {
    for (const [handle, timer] of this.due) {
      if (timer.at > this.clock.now()) continue;
      this.due.delete(handle);
      timer.fn();
    }
  }
}

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Run the watch and the bridge's 12 s poll side by side for `seconds` of fake time. Answers the time of
 * each snapshot read the program saw, counted from the first census, and how often the bridge polled.
 */
async function interleave(attention: "watched" | "idle", seconds: number, kind: "https" | "socket" = "https"): Promise<{ reads: number[]; bridgePolls: number }> {
  const clock = new FakeDurableClock();
  const program = new BilledProgram(clock, kind);
  const adapter = new DurableMux(program, clock);
  const timers = new FakeTimers(clock);
  const noop = (): void => undefined;
  const watch = new DurableWatch(adapter, { panes: [], onUp: noop, onDown: noop, onTopologyChange: noop, onPaneChange: noop, attention: () => attention }, timers);
  await settled();
  const start = clock.now();
  const end = start + seconds * 1000;
  let bridgeAt = start + BRIDGE_POLL_MS;
  let bridgePolls = 0;
  for (;;) {
    const watchAt = timers.next();
    const at = Math.min(watchAt, bridgeAt);
    if (at > end) break;
    clock.advance(at - clock.now());
    if (at === watchAt) {
      timers.fireDue();
    } else {
      expect((await adapter.poll()).ok).toBe(true);
      bridgeAt += BRIDGE_POLL_MS;
      bridgePolls += 1;
    }
    await settled();
  }
  watch.close();
  return { reads: program.reads.map((time) => time - start), bridgePolls };
}

/** The gaps between two reads in a row. */
const gaps = (reads: readonly number[]): number[] => reads.slice(1).map((time, i) => time - (reads[i] ?? 0));

describe("the http transport: the watch is the only dialer", () => {
  test("dialer: idle, with the bridge's 12 s poll and the 10 s watch interleaved, the program sees one read per 10 s", async () => {
    const { reads, bridgePolls } = await interleave("idle", 120);
    expect(bridgePolls).toBe(10);
    expect(reads).toHaveLength(13); // at 0, 10, 20 ... 120 s
    expect(new Set(gaps(reads))).toEqual(new Set([DURABLE_BUDGETS.https.idlePollMs]));
    // A day of it: 8,640 Durable Object requests, as ADR 0103 and the README say.
    expect((24 * 60 * 60 * 1000) / DURABLE_BUDGETS.https.idlePollMs).toBe(8640);
  });

  test("dialer: watched, the program sees one read per 2 s, and the bridge's poll adds none", async () => {
    const { reads, bridgePolls } = await interleave("watched", 60);
    expect(bridgePolls).toBe(5);
    expect(reads).toHaveLength(31); // at 0, 2, 4 ... 60 s
    expect(new Set(gaps(reads))).toEqual(new Set([DURABLE_BUDGETS.https.watchedPollMs]));
  });

  test("dialer: one read per census, and a refresh() still reads at once past the floor", async () => {
    const clock = new FakeDurableClock();
    const program = new BilledProgram(clock);
    const adapter = new DurableMux(program, clock);
    expect((await adapter.census(DURABLE_BUDGETS.https.idlePollMs)).ok).toBe(true);
    clock.advance(MIN_SNAPSHOT_GAP_MS + 50);
    await adapter.poll(); // the bridge's poll, inside the cadence: served, not read
    expect(program.reads).toHaveLength(1);
    await adapter.refresh(); // a person's look: read now
    expect(program.reads).toHaveLength(2);
    await adapter.poll(); // and served again after it
    expect(program.reads).toHaveLength(2);
    clock.advance(DURABLE_BUDGETS.https.idlePollMs);
    await adapter.poll(); // no watch read for a whole cadence: the poll reads, so nothing goes stale for good
    expect(program.reads).toHaveLength(3);
  });

  test("dialer: over the socket nothing changes, and the bridge's own poll reads past the floor (one read each)", async () => {
    const clock = new FakeDurableClock();
    const program = new BilledProgram(clock, "socket");
    const adapter = new DurableMux(program, clock);
    expect((await adapter.poll()).ok).toBe(true);
    clock.advance(MIN_SNAPSHOT_GAP_MS + 50);
    expect((await adapter.poll()).ok).toBe(true);
    expect(program.reads).toHaveLength(2);
  });
});

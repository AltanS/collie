// route.ts and with-collie.ts against the fake World (M66 spec 03): the token, the asks through the journal and the
// guard that waits on them (with two route instances taking turns), the zombie, a send while an ask waits, a double
// answer, expiry, a stop, receipts, a stale World, and the p95 of a poll on a 200-entry session.
import { describe, expect, test } from "bun:test";
import { api, call } from "../../durable-member/tests/client.ts";
import { paneIdOfRun } from "../../../packages/durable-sdk/src/durable-harness/pi-source.ts";
import { KEPT_MAX, KEPT_SIZE, tokenAccepted } from "../../../packages/durable-sdk/src/durable-harness/route.ts";
import { askThroughJournal } from "../../../packages/durable-sdk/src/durable-harness/with-collie.ts";
import { HttpError } from "../../../packages/durable-sdk/src/core/receipts.ts";
import { assistantEntry, longSession, task, userEntry } from "./fake-world.ts";
import { FakeSession, rig, TOKEN, until, withToken } from "./rig.ts";

const FAST = { pollMs: { first: 5, max: 20 } };
const idleSession = { eventCount: 4, entries: [userEntry(1, "refund 5521"), assistantEntry(3, "On it.")] };

/** A guard waiting on a risky call in `runId`, as the hook in the program's process would. */
function guard(r: ReturnType<typeof rig>, runId: string, o: { args?: object; timeoutMs?: number; session?: FakeSession; onTimeout?: () => void } = {}) {
  const session = o.session ?? new FakeSession(runId);
  const decided = askThroughJournal({ id: "call-1", name: "refund", arguments: o.args ?? { order: "5521" } }, session, r.world.port(), { ...FAST, ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }), ...(o.onTimeout === undefined ? {} : { onTimeout: o.onTimeout }) });
  return { session, decided };
}

const openAsk = async (r: ReturnType<typeof rig>, paneId: string) =>
  until("the ask on the phone", async () => (await api.snapshot(r.dial())).body.panes.find((p) => p.id === paneId)?.openAsks[0]);

describe("the token", () => {
  test("no token, a wrong one, or a configured one under 32 bytes is a bare 401, and the World is never read", async () => {
    const r = rig();
    r.world.addRun({ session: idleSession });
    const bare = await r.routes[0]!(new Request("http://h/collie/session/v1/snapshot", { headers: { "x-collie-session": "1" } }));
    expect([bare.status, await bare.json(), bare.headers.get("www-authenticate")]).toEqual([401, { code: "unauthorized" }, "Bearer"]);
    expect((await api.snapshot({ version: 1, handler: withToken(r.routes[0]!, `${TOKEN}x`) })).status).toBe(401);
    expect(r.world.calls).toEqual([]);
    const short = rig({ route: { token: "short" } });
    expect((await api.hello({ version: 1, handler: withToken(short.routes[0]!, "short") })).status).toBe(401);
  });

  test("tokenNext is accepted beside the token while a rotation runs; each compare is over two SHA-256 digests", async () => {
    const next = "next-token-not-a-secret-0123456789abcdef";
    const req = (t: string) => new Request("http://h/", { headers: { authorization: `Bearer ${t}` } });
    expect(await tokenAccepted(req(next), TOKEN, next)).toBe(true);
    expect(await tokenAccepted(req(TOKEN), TOKEN, next)).toBe(true);
    expect(await tokenAccepted(req("x"), TOKEN, next)).toBe(false);
    expect(await tokenAccepted(req(TOKEN), undefined)).toBe(false);
  });

  test("the route answers under any mount that ends in /session/v1, and 404 elsewhere", async () => {
    const r = rig();
    const at = (path: string) => withToken(r.routes[0]!)(new Request(`http://h${path}`, { headers: { "x-collie-session": "1" } }));
    expect((await at("/collie/session/v1/hello")).status).toBe(200);
    expect((await at("/session/v1/hello")).status).toBe(200);
    expect((await at("/collie/other")).status).toBe(404);
  });
});

describe("hello and snapshot", () => {
  test("caps: asks, send, abort and history; never rename, close, reopen, actions, starters or steer", async () => {
    const r = rig();
    const hello = (await api.hello(r.dial())).body;
    expect(hello.caps).toEqual({ asks: true, starters: false, send: true, steer: false, abort: true, rename: false, close: false, actions: false, history: true, reopen: false, terminal: false });
    expect(hello.ready).toBe(true);
  });

  test("the epoch is a fact of the World and the program: the same on every instance and every start, never random", async () => {
    const a = rig({ instances: 2 });
    const e0 = (await api.hello(a.dial(0))).body.epoch;
    expect((await api.hello(a.dial(1))).body.epoch).toBe(e0);
    expect((await api.hello(rig().dial())).body.epoch).toBe(e0); // a new World object, the same identity
    expect((await api.hello(rig({ route: { name: "other" } }).dial())).body.epoch).not.toBe(e0);
    expect((await api.hello(rig({ route: { epoch: "e-1" } }).dial())).body.epoch).toBe("e-1");
  });

  test("a pane per open run; its turn, its state, and an ETag that moves when the log or the journal grows", async () => {
    const r = rig({ instances: 2 });
    const run = r.world.addRun({ session: idleSession });
    r.world.addRun({ status: "completed" });
    const first = await api.snapshot(r.dial());
    expect(first.body.panes.map((p) => [p.id, p.title, p.state, p.harness])).toEqual([[paneIdOfRun(run), "refund 5521", "idle", "pi"]]);
    expect((await api.snapshot(r.dial(), first.etag)).status).toBe(304);
    r.world.setSession(run, { eventCount: 5 });
    const moved = await api.snapshot(r.dial(), first.etag);
    expect(moved.status).toBe(200);
    expect(moved.body.rev).toBeGreaterThan(first.body.rev);
    await r.world.port().appendJournal(run, { t: "expire", askId: "x", at: "2026-10-21T12:00:00.000Z" });
    const again = await api.snapshot(r.dial(), moved.etag);
    expect(again.body.rev).toBeGreaterThan(moved.body.rev);
  });

  test("events: a read at the pane's cursor is empty; any other read is the reset view with the cursor as next", async () => {
    const r = rig({ instances: 2 });
    const run = r.world.addRun({ session: idleSession });
    const pane = paneIdOfRun(run);
    const reset = (await api.events(r.dial(), pane, 0)).body;
    expect(reset.reset).toBe(true);
    expect(reset.events.filter((e) => e.type === "item").map((e) => e.type === "item" && e.item.kind)).toEqual(["user", "reply"]);
    expect((await api.events(r.dial(), pane, reset.next)).body).toMatchObject({ events: [], next: reset.next });
    r.world.setSession(run, { eventCount: 6, entries: [...idleSession.entries, userEntry(5, "more")] });
    const grown = (await api.events(r.dial(), pane, reset.next)).body;
    expect(grown.reset).toBe(true);
    expect(grown.next).toBeGreaterThan(reset.next);
  });
});

describe("an ask through the journal", () => {
  test("the guard's ask reaches the phone through either instance; an allow lets the call run; a second answer is 409 decided", async () => {
    const r = rig({ instances: 2 });
    const run = r.world.addRun({ session: { ...idleSession, unfinished: true, tasks: [task("t", 2)] } });
    const pane = paneIdOfRun(run);
    const { decided } = guard(r, run);
    const ask = await openAsk(r, pane);
    expect(ask).toMatchObject({ kind: "permission", title: "refund wants to run", revision: 1, tool: { name: "refund", summary: "5521" } });
    expect((await api.snapshot(r.dial())).body.panes[0]!.state).toBe("waiting");
    const requestId = "req-allow-1";
    expect((await api.answer(r.dial(0), pane, ask.id, "allow", { requestId })).body).toEqual({ result: "taken" });
    expect(await decided).toBeUndefined();
    const repeat = await api.answer(r.dial(1), pane, ask.id, "allow", { requestId });
    expect(repeat.body).toEqual({ result: "taken", replayed: true });
    const second = await api.answer(r.dial(1), pane, ask.id, "deny");
    expect([second.status, second.body.code, second.body.outcome?.decidedBy, second.body.outcome?.optionId]).toEqual([409, "decided", "phone", "allow"]);
  });

  test("a deny blocks the call", async () => {
    const r = rig();
    const run = r.world.addRun({ session: idleSession });
    const { decided } = guard(r, run);
    const ask = await openAsk(r, paneIdOfRun(run));
    await api.answer(r.dial(), paneIdOfRun(run), ask.id, "deny");
    expect(await decided).toEqual({ block: "denied from the phone" });
  });

  test("two answers at once from two instances: one is taken, the other 409 decided with the winner", async () => {
    const r = rig({ instances: 2 });
    const run = r.world.addRun({ session: idleSession });
    const pane = paneIdOfRun(run);
    const { decided } = guard(r, run);
    const ask = await openAsk(r, pane);
    const [a, b] = await Promise.all([api.answer(r.dial(0), pane, ask.id, "allow"), api.answer(r.dial(1), pane, ask.id, "deny")]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const winner = a.status === 200 ? "allow" : "deny";
    expect((a.status === 409 ? a : b).body.outcome.optionId).toBe(winner);
    expect(await decided).toEqual(winner === "allow" ? undefined : { block: "denied from the phone" });
  });

  test("the zombie: a guard whose process lost the session sees the answer and still does not allow", async () => {
    const r = rig();
    const run = r.world.addRun({ session: idleSession });
    const { session, decided } = guard(r, run);
    const ask = await openAsk(r, paneIdOfRun(run));
    session.fence();
    await api.answer(r.dial(), paneIdOfRun(run), ask.id, "allow");
    expect(await decided).toEqual({ block: "this process lost the session" });
  });

  test("a rerun of the same call waits on the same ask; a rerun with other arguments is refused and closes it", async () => {
    const r = rig();
    const run = r.world.addRun({ session: idleSession });
    const first = guard(r, run);
    const ask = await openAsk(r, paneIdOfRun(run));
    first.session.fence(); // the process dies; its guard gives up
    expect(await first.decided).toEqual({ block: "this process lost the session" });
    const rerun = guard(r, run);
    await api.answer(r.dial(), paneIdOfRun(run), ask.id, "allow"); // an answer to the ask the phone saw before the takeover
    expect(await rerun.decided).toBeUndefined();
    expect((await r.world.port().readJournal(run)).filter((x) => x.t === "ask").length).toBe(1);
    const other = r.world.addRun({ session: idleSession });
    guard(r, other);
    await openAsk(r, paneIdOfRun(other));
    const changed = guard(r, other, { args: { order: "9999" } });
    expect(await changed.decided).toEqual({ block: "the arguments changed" });
    expect((await r.world.port().readJournal(other)).at(-1)).toMatchObject({ t: "expire", decidedBy: "program" });
  });

  test("expiry: the guard closes the ask at expiresAt and blocks; the phone then reads it as decided by timeout", async () => {
    const r = rig();
    const run = r.world.addRun({ session: idleSession });
    let timedOut = 0;
    const { decided } = guard(r, run, { timeoutMs: 150, onTimeout: () => void timedOut++ });
    const ask = await openAsk(r, paneIdOfRun(run));
    expect(ask.expiresAt).toBeDefined();
    expect(await decided).toEqual({ block: "timed out" });
    expect(timedOut).toBe(1);
    expect((await api.snapshot(r.dial())).body.panes[0]!.openAsks).toEqual([]);
    const late = await api.answer(r.dial(), paneIdOfRun(run), ask.id, "allow", { revision: 1 });
    expect([late.status, late.body.outcome?.decidedBy, late.body.outcome?.decidedAt]).toEqual([409, "timeout", ask.expiresAt]);
  });
});

describe("send and stop", () => {
  test("send while an ask waits is refused, 409 not-supported, and nothing reaches the controls", async () => {
    const r = rig();
    const run = r.world.addRun({ session: idleSession });
    guard(r, run);
    await openAsk(r, paneIdOfRun(run));
    const sent = await api.send(r.dial(), paneIdOfRun(run), "hello");
    expect([sent.status, sent.body.code]).toEqual([409, "not-supported"]);
    expect(r.controls.sends).toEqual([]);
  });

  test("send while a turn runs is refused too: steer is off on this host", async () => {
    const r = rig();
    const run = r.world.addRun({ session: { ...idleSession, unfinished: true, tasks: [task("t", 4)] } });
    expect((await api.send(r.dial(), paneIdOfRun(run), "hello")).status).toBe(409);
  });

  test("an idle send runs once for one request id, through either instance, and its receipt is in the journal", async () => {
    const r = rig({ instances: 2 });
    const run = r.world.addRun({ session: idleSession });
    const pane = paneIdOfRun(run);
    const turnId = (await api.snapshot(r.dial())).body.panes[0]!.turnId;
    const first = await api.send(r.dial(0), pane, "hello", { requestId: "req-send-1", turnId });
    const again = await api.send(r.dial(1), pane, "hello", { requestId: "req-send-1", turnId });
    expect([first.body, again.body]).toEqual([{ ok: true }, { ok: true, replayed: true }]);
    expect(r.controls.sends).toEqual([{ paneId: pane, text: "hello", requestId: "req-send-1", turnId }]);
    const receipts = (await r.world.port().readJournal(run)).filter((x) => x.t === "receipt");
    expect(receipts.map((x) => x.t === "receipt" && x.phase)).toEqual(["pending", "done"]);
    const reused = await api.send(r.dial(), pane, "other text", { requestId: "req-send-1", turnId });
    expect([reused.status, reused.body.code]).toEqual([409, "request-id-reused"]);
  });

  test("a send the controls refuse frees its request id: the same id may try again", async () => {
    const r = rig();
    const run = r.world.addRun({ session: idleSession });
    const pane = paneIdOfRun(run);
    r.controls.failNext = new HttpError(409, "stale");
    const refused = await api.send(r.dial(), pane, "hello", { requestId: "req-send-2" });
    expect([refused.status, refused.body.code]).toEqual([409, "stale"]);
    expect((await api.send(r.dial(), pane, "hello", { requestId: "req-send-2" })).body).toEqual({ ok: true });
    expect(r.controls.sends.length).toBe(1);
  });

  test("a stop reaches the controls, and closes the turn's open asks as decided by the program; the guard blocks", async () => {
    const r = rig();
    const run = r.world.addRun({ session: { ...idleSession, unfinished: true, tasks: [task("t", 2)] } });
    const pane = paneIdOfRun(run);
    const { decided } = guard(r, run);
    await openAsk(r, pane);
    expect((await api.abort(r.dial(), pane)).body).toEqual({ ok: true });
    expect(r.controls.aborts.map((a) => a.paneId)).toEqual([pane]);
    expect(await decided).toEqual({ block: "stopped" });
    expect((await r.world.port().readJournal(run)).find((x) => x.t === "expire")).toMatchObject({ decidedBy: "program" });
  });
});

describe("a stale World", () => {
  test("a GET is answered from the last good answer for 5 s, then 503 starting; hello says ready: false", async () => {
    let now = 1_000_000;
    const r = rig({ route: { now: () => now } });
    r.world.addRun({ session: idleSession });
    const good = await api.snapshot(r.dial());
    expect(good.status).toBe(200);
    r.world.down = true;
    now += 4000;
    const stale = await api.snapshot(r.dial());
    expect([stale.status, stale.body]).toEqual([200, good.body]);
    expect((await api.snapshot(r.dial(), good.etag)).status).toBe(304);
    now += 1500;
    const gone = await api.snapshot(r.dial());
    expect([gone.status, gone.body.code]).toEqual([503, "starting"]);
    const hello = await call(r.dial(), "GET", "/hello");
    expect([hello.status, hello.body.ready]).toEqual([200, false]);
    expect(r.warnings.some((w) => w.includes("did not answer"))).toBe(true);
  });

  test("a World that lags its writes: an answer reads its own record back before it says taken", async () => {
    const r = rig({ world: { lagMs: 60 }, instances: 2 });
    const run = r.world.addRun({ session: idleSession });
    const { decided } = guard(r, run);
    const ask = await openAsk(r, paneIdOfRun(run));
    expect((await api.answer(r.dial(), paneIdOfRun(run), ask.id, "allow")).body).toEqual({ result: "taken" });
    expect(await decided).toBeUndefined();
  });
});

describe("latency", () => {
  test("p95 of a poll on a 200-entry session over the fake World", async () => {
    const r = rig({ instances: 2 });
    const run = r.world.addRun({ session: longSession(200) });
    const pane = paneIdOfRun(run);
    const time = async (f: () => Promise<unknown>) => {
      const t0 = performance.now();
      await f();
      return performance.now() - t0;
    };
    const epoch = (await api.hello(r.dial())).body.epoch;
    const snapshots: number[] = [];
    const resets: number[] = [];
    const quiet: number[] = [];
    const cursor = (await api.events(r.dial(), pane, 0, epoch)).body.next;
    for (let i = 0; i < 60; i++) {
      snapshots.push(await time(() => api.snapshot(r.dial())));
      resets.push(await time(() => api.events(r.dial(), pane, 0, epoch)));
      quiet.push(await time(() => api.events(r.dial(), pane, cursor, epoch)));
    }
    const p95 = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!;
    const line = `p95 on a 200-entry session: snapshot ${p95(snapshots).toFixed(1)} ms, events reset ${p95(resets).toFixed(1)} ms, events at cursor ${p95(quiet).toFixed(1)} ms`;
    console.log(line);
    expect(p95(snapshots)).toBeLessThan(1000);
    expect(p95(resets)).toBeLessThan(1000);
    expect(p95(quiet)).toBeLessThan(1000);
  });
});

describe("the snapshot's rev never falls", () => {
  test("a run that finishes takes its pane out, and the rev still rises", async () => {
    const r = rig();
    const run = r.world.addRun({ session: { ...idleSession, eventCount: 500 } });
    r.world.addRun({ session: idleSession });
    const before = (await api.snapshot(r.dial())).body;
    r.world.runs.get(run)!.status = "completed";
    const after = (await api.snapshot(r.dial())).body;
    expect(after.panes.length).toBe(before.panes.length - 1);
    expect(after.rev).toBeGreaterThan(before.rev);
  });
});

describe("the stale-answer cache is bounded", () => {
  test("200 events reads with rising cursors keep at most 64 answers, and one older than staleMs goes at the next keep", async () => {
    let now = 1_000_000;
    const r = rig({ route: { now: () => now } });
    const run = r.world.addRun({ session: idleSession });
    const pane = paneIdOfRun(run);
    // SAFETY (test): createRoute attaches the size probe; collieRoute's public type does not name it.
    const size = (r.routes[0] as unknown as { [KEPT_SIZE]: () => number })[KEPT_SIZE];
    const epoch = (await api.hello(r.dial())).body.epoch;
    for (let after = 0; after < 200; after++) expect((await api.events(r.dial(), pane, after, epoch)).status).toBe(200);
    expect(size()).toBeLessThanOrEqual(KEPT_MAX);
    expect(KEPT_MAX).toBe(64);
    now += 6000; // past staleMs (5000)
    await api.snapshot(r.dial());
    expect(size()).toBe(1);
  });
});

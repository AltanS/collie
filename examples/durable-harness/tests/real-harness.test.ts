// The real durable-harness on world-local (M66 spec 03), in spawned Node processes (tests/node/proc.mjs): Pi's faux
// model calls a risky tool, the guard of `withCollie` asks through the run's journal, and `collieRoute` serves the
// phone over HTTP. On Node, not Bun: the SDK source and durable-harness must load one copy of Pi (tests/node/loader.mjs).
//
// Each test is one scenario of proc.mjs (see its header for the commands and the environment). The adapter over loopback
// HTTP is bridge/mux/durable/example-durable-harness.test.ts, which starts server.ts instead of proc.mjs.
import { afterAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, type Dial } from "../../durable-member/tests/client.ts";
import { TOKEN, until, withToken } from "./rig.ts";

const NODE = spawnSync("node", ["--version"], { encoding: "utf8" });
const nodeMajor = NODE.status === 0 ? Number(/^v(\d+)/.exec(NODE.stdout)?.[1] ?? 0) : 0;
/** Node 23.6 and later run the SDK's TypeScript source as it is. */
const realHarness = test.skipIf(nodeMajor < 23);

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) c.kill("SIGKILL");
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Proc {
  child: ChildProcess;
  lines: { ev: string; [k: string]: unknown }[];
  stderr: () => string;
}

function proc(dir: string, role: string, args: string[], env: Record<string, string> = {}): Proc {
  const child = spawn("node", ["--import", "./register.mjs", "proc.mjs", ...args], {
    cwd: new URL("./node/", import.meta.url).pathname,
    env: { ...process.env, DH_DIR: dir, DH_ROLE: role, COLLIE_TOKEN: TOKEN, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const lines: Proc["lines"] = [];
  let err = "";
  let rest = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
    const parts = (rest + chunk).split("\n");
    rest = parts.pop() ?? "";
    for (const line of parts) if (line.startsWith("{")) lines.push(JSON.parse(line));
  });
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
  return { child, lines, stderr: () => err };
}

/** A dial to a process's route, over HTTP on loopback, with the token. */
async function dialOf(p: Proc): Promise<Dial> {
  const port = (await until(`the route of ${p.stderr().slice(-300)}`, () => p.lines.find((l) => l.ev === "listening")?.port as number | undefined, 30000)) as number;
  const handler = withToken(async (r: Request) => {
    const url = new URL(r.url);
    const body = r.method === "GET" ? undefined : await r.text();
    return fetch(`http://127.0.0.1:${port}/collie${url.pathname}${url.search}`, { method: r.method, headers: r.headers, ...(body === undefined ? {} : { body }) });
  });
  return { version: 1, handler };
}

const marks = (dir: string) => (existsSync(join(dir, "marks.txt")) ? readFileSync(join(dir, "marks.txt"), "utf8").trim().split("\n").filter(Boolean) : []);
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "m66-real-"));
  dirs.push(dir);
  return dir;
};
const firstAsk = async (d: Dial) => until("the ask", async () => (await api.snapshot(d)).body.panes?.[0]?.openAsks?.[0], 30000);

describe("a real durable-harness session", () => {
  realHarness(
    "the guard asks through the journal, the phone allows, the tool runs once, and the pane goes idle",
    async () => {
      const dir = fresh();
      const a = proc(dir, "A", ["serve", "please mark one"]);
      const d = await dialOf(a);
      const ask = await firstAsk(d);
      const pane = (await api.snapshot(d)).body.panes[0]!;
      expect([pane.state, ask.title, ask.tool?.summary]).toEqual(["waiting", "mark wants to run", "please mark one"]);
      expect(marks(dir)).toEqual([]);
      expect((await api.answer(d, pane.id, ask.id, "allow")).body).toEqual({ result: "taken" });
      await until("the tool", () => (marks(dir).length > 0 ? true : undefined), 30000);
      await until("idle", async () => ((await api.snapshot(d)).body.panes[0]?.state === "idle" ? true : undefined), 30000);
      expect(marks(dir)).toEqual(["A please mark one"]);
      const items = (await api.events(d, pane.id, 0)).body.events.flatMap((e) => (e.type === "item" ? [e.item] : []));
      expect(items.find((i) => i.kind === "tool")).toMatchObject({ status: "done", tool: { name: "mark" } });
    },
    60000,
  );

  realHarness(
    "a stop while the guard waits: the turn ends, the ask closes as decided by the program, and the tool never runs",
    async () => {
      const dir = fresh();
      const a = proc(dir, "A", ["serve", "please mark two"]);
      const d = await dialOf(a);
      const ask = await firstAsk(d);
      const pane = (await api.snapshot(d)).body.panes[0]!;
      expect((await api.abort(d, pane.id)).body).toEqual({ ok: true });
      await until("idle", async () => ((await api.snapshot(d)).body.panes[0]?.state === "idle" ? true : undefined), 30000);
      const late = await api.answer(d, pane.id, ask.id, "allow");
      expect([late.status, late.body.outcome?.decidedBy]).toEqual([409, "program"]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(marks(dir)).toEqual([]);
    },
    60000,
  );

  realHarness(
    "a takeover reruns the hook: the new process finds the same ask in the journal, an answer to it lands, the tool runs once",
    async () => {
      const dir = fresh();
      const a = proc(dir, "A", ["serve", "please mark three"]);
      const ask = await firstAsk(await dialOf(a));
      a.child.kill("SIGKILL");
      await new Promise((resolve) => a.child.once("exit", resolve));
      const b = proc(dir, "B", ["serve"]); // world-local's recovery reopens the session and Pi reruns the call
      const d = await dialOf(b);
      const again = await firstAsk(d);
      expect(again.id).toBe(ask.id);
      const pane = (await api.snapshot(d)).body.panes[0]!;
      expect((await api.answer(d, pane.id, ask.id, "allow")).body).toEqual({ result: "taken" });
      await until("the tool", () => (marks(dir).length > 0 ? true : undefined), 30000);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(marks(dir)).toEqual(["B please mark three"]);
    },
    90000,
  );
  realHarness(
    "two processes: C only serves a route, shows A's ask and takes the answer, and A runs the tool once",
    async () => {
      const dir = fresh();
      const a = proc(dir, "A", ["serve", "please mark four"]);
      const ask = await firstAsk(await dialOf(a));
      const c = proc(dir, "C", ["serve"]); // no prompt: it owns no session, it only answers HTTP over the same data folder
      const d = await dialOf(c);
      const seen = await firstAsk(d);
      expect(seen.id).toBe(ask.id);
      const pane = (await api.snapshot(d)).body.panes[0]!;
      expect((await api.answer(d, pane.id, ask.id, "allow")).body).toEqual({ result: "taken" });
      await until("the tool", () => (marks(dir).length > 0 ? true : undefined), 30000);
      await until("idle", async () => ((await api.snapshot(d)).body.panes[0]?.state === "idle" ? true : undefined), 30000);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(marks(dir)).toEqual(["A please mark four"]);
    },
    90000,
  );
  // THE SEND RULE (spike 01 Q5, M66): a send reaches the session only through a process that runs the queue. On
  // world-local a process that serves the route without starting the World (DH_QUEUE=0) takes the send into the log, and
  // nobody drives it until a process that starts the World runs its recovery.
  realHarness(
    "a send through a process with no queue lands in the log and runs nothing, even with A alive, until a restart",
    async () => {
      const dir = fresh();
      const a = proc(dir, "A", ["serve", "please mark five"]);
      const da = await dialOf(a);
      const ask = await firstAsk(da);
      const first = (await api.snapshot(da)).body.panes[0]!;
      await api.answer(da, first.id, ask.id, "allow");
      await until("idle", async () => ((await api.snapshot(da)).body.panes[0]?.state === "idle" ? true : undefined), 30000);

      const c = proc(dir, "C", ["serve"], { DH_QUEUE: "0" });
      const dc = await dialOf(c);
      const turnId = (await api.snapshot(dc)).body.panes[0]!.turnId; // the idle turn the phone saw when it sent
      const sent = await api.send(dc, first.id, "please mark six", { requestId: "send-six", turnId });
      expect([sent.status, sent.body]).toEqual([200, { ok: true }]);
      // The same request id again is the same answer, and writes nothing new.
      const again = await api.send(dc, first.id, "please mark six", { requestId: "send-six", turnId });
      expect([again.status, again.body]).toEqual([200, { ok: true, replayed: true }]);
      const userItems = async (d: Dial) => (await api.events(d, first.id, 0)).body.events.flatMap((e) => (e.type === "item" && e.item.kind === "user" ? [e.item.text] : []));
      expect(await userItems(dc)).toEqual(["please mark five", "please mark six"]); // the entry landed, once

      await new Promise((resolve) => setTimeout(resolve, 3000)); // A is alive and idle, and still does nothing with it
      let pane = (await api.snapshot(dc)).body.panes[0]!;
      expect([pane.state, pane.openAsks.length]).toEqual(["working", 0]);
      a.child.kill("SIGKILL");
      c.child.kill("SIGKILL");
      await new Promise((resolve) => a.child.once("exit", resolve));
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(marks(dir)).toEqual(["A please mark five"]); // dead, and still nothing ran

      const b = proc(dir, "B", ["serve"]); // a restart: the World starts, the recovery finds the entry and drives the turn
      const db = await dialOf(b);
      const waiting = await firstAsk(db);
      expect(waiting.tool?.summary).toBe("please mark six");
      expect((await api.answer(db, first.id, waiting.id, "allow")).body).toEqual({ result: "taken" });
      await until("idle", async () => ((await api.snapshot(db)).body.panes[0]?.state === "idle" ? true : undefined), 30000);
      expect(marks(dir)).toEqual(["A please mark five", "B please mark six"]);
    },
    90000,
  );

  realHarness(
    "a send through a process that runs the queue starts the turn there, and the guard asks again",
    async () => {
      const dir = fresh();
      const a = proc(dir, "A", ["serve", "please mark five"]);
      const da = await dialOf(a);
      const ask = await firstAsk(da);
      const first = (await api.snapshot(da)).body.panes[0]!;
      await api.answer(da, first.id, ask.id, "allow");
      await until("idle", async () => ((await api.snapshot(da)).body.panes[0]?.state === "idle" ? true : undefined), 30000);
      a.child.kill("SIGKILL");
      await new Promise((resolve) => a.child.once("exit", resolve));

      const c = proc(dir, "C", ["serve"]); // this one starts the World: its queue is the process that drives
      const dc = await dialOf(c);
      expect((await api.send(dc, first.id, "please mark six")).body).toEqual({ ok: true });
      const waiting = await firstAsk(dc);
      expect(waiting.tool?.summary).toBe("please mark six");
      expect((await api.answer(dc, first.id, waiting.id, "allow")).body).toEqual({ result: "taken" });
      await until("idle", async () => ((await api.snapshot(dc)).body.panes[0]?.state === "idle" ? true : undefined), 30000);
      expect(marks(dir)).toEqual(["A please mark five", "C please mark six"]);
    },
    90000,
  );

  // THE ZOMBIE: A dies by SIGKILL while its tool runs. B starts and recovers the session. Pi keeps at most one run of a
  // tool that was running when its process died: the tool is not run a second time. Whether it ran before the kill
  // decides the marks, and the pane ends idle either way, with no ask left open.
  for (const order of ["before", "after"] as const) {
    realHarness(
      `a process killed while its tool runs (the line written ${order} the wait): the recovery runs nothing twice and the pane ends idle`,
      async () => {
        const dir = fresh();
        const slow = { DH_TOOL_MS: "4000", DH_TOOL_ORDER: order };
        const a = proc(dir, "A", ["serve", "please mark seven"], slow);
        const da = await dialOf(a);
        const ask = await firstAsk(da);
        const pane = (await api.snapshot(da)).body.panes[0]!;
        await api.answer(da, pane.id, ask.id, "allow");
        await until("the tool to start", () => a.lines.find((l) => l.ev === "tool-start"), 30000);
        await new Promise((resolve) => setTimeout(resolve, 500));
        a.child.kill("SIGKILL");
        await new Promise((resolve) => a.child.once("exit", resolve));
        const ranInA = marks(dir);
        expect(ranInA).toEqual(order === "before" ? ["A please mark seven"] : []);

        const b = proc(dir, "B", ["serve"], slow);
        const db = await dialOf(b);
        await until("idle", async () => ((await api.snapshot(db)).body.panes[0]?.state === "idle" ? true : undefined), 30000);
        await new Promise((resolve) => setTimeout(resolve, 5000)); // longer than the tool: a second run would show by now
        expect(marks(dir).length).toBeLessThanOrEqual(1);
        expect(marks(dir)).toEqual(ranInA);
        expect((await api.snapshot(db)).body.panes[0]).toMatchObject({ state: "idle", openAsks: [] });
      },
      90000,
    );
  }

  // THE FENCE (spike 01 Q1, M66): B takes the session over while A's guard waits, B's hook run asks the same ask, and
  // one answer lets both guards through. A is fenced when it comes to commit the execute intent of the tool, so A
  // never runs it. Exactly one run of the tool, and it is B's.
  realHarness(
    "a takeover while the guard waits: both guards read the same answer, the fenced process never runs the tool and the new one runs it once",
    async () => {
      const dir = fresh();
      const a = proc(dir, "A", ["serve", "please mark eight"]);
      const da = await dialOf(a);
      const ask = await firstAsk(da);
      const sessionId = (await until("A's session line", () => a.lines.find((l) => l.ev === "session")?.id as string | undefined, 30000)) as string;
      const b = proc(dir, "B", ["take", sessionId]);
      const db = await dialOf(b);
      await until("the takeover", () => b.lines.find((l) => l.ev === "taken"), 30000);
      expect((await firstAsk(db)).id).toBe(ask.id); // B's rerun of the hook finds the same ask in the journal
      const pane = (await api.snapshot(da)).body.panes[0]!;
      expect((await api.answer(da, pane.id, ask.id, "allow")).body).toEqual({ result: "taken" });
      await until("the tool", () => (marks(dir).length > 0 ? true : undefined), 30000);
      await until("idle", async () => ((await api.snapshot(db)).body.panes[0]?.state === "idle" ? true : undefined), 30000);
      await new Promise((resolve) => setTimeout(resolve, 2000)); // a second run, or A's late one, would show by now
      expect(marks(dir)).toEqual(["B please mark eight"]);
      expect(a.lines.filter((l) => l.ev === "tool-ran")).toEqual([]);
    },
    90000,
  );

  // THE COST OF A POLL: 50 snapshots of one session with 200 entries (100 chat turns), each one a full read of the log
  // through the route, since the route keeps nothing between two requests. The bound is the spec's: p95 under 1 s.
  realHarness(
    "p95 of 50 snapshot polls on a session of 200 entries is under one second",
    async () => {
      const dir = fresh();
      const a = proc(dir, "A", ["serve"], { DH_FILL: "100" });
      const d = await dialOf(a);
      await until("the fill", () => a.lines.find((l) => l.ev === "filled"), 80000);
      const pane = (await api.snapshot(d)).body.panes[0]!;
      const items = (await api.events(d, pane.id, 0)).body.events.filter((e) => e.type === "item").length;
      expect(items).toBeGreaterThanOrEqual(200);
      // The first dial is the process that owns the session. The second is a process that only serves the route
      // over the same folder: its World is never started, so every poll reads the log from disk.
      const c = proc(dir, "C", ["serve"], { DH_QUEUE: "0" });
      for (const [who, dial] of [["owner", d], ["route only", await dialOf(c)]] as const) {
        const times: number[] = [];
        for (let i = 0; i < 50; i++) {
          const t0 = performance.now();
          const reply = await api.snapshot(dial);
          times.push(performance.now() - t0);
          expect(reply.status).toBe(200);
        }
        const firstMs = times[0]!; // the port keeps a reader warm after the first read, so only this one reads the whole log
        times.sort((x, y) => x - y);
        const p95 = times[Math.ceil(0.95 * times.length) - 1]!;
        console.log(`snapshot poll, ${items} items, 50 polls, real world-local, ${who}: first ${firstMs.toFixed(1)} ms, p50 ${times[24]!.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${times[49]!.toFixed(1)} ms`);
        expect(p95).toBeLessThan(1000);
      }
    },
    90000,
  );
});

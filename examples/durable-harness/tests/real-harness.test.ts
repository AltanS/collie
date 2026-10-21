// The real durable-harness on world-local (M66 spec 03), in spawned Node processes (tests/node/proc.mjs): Pi's faux
// model calls a risky tool, the guard of `withCollie` asks through the run's journal, and `collieRoute` serves the
// phone over HTTP. On Node, not Bun: the SDK source and durable-harness must load one copy of Pi (tests/node/loader.mjs).
//
// SPEC 04 EXTENDS THIS FILE: the two-process ask, the takeover with the rerun (a first cut is below), and the adapter
// over loopback HTTP. Each test here is one scenario of proc.mjs; add a command there and a test here.
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

function proc(dir: string, role: string, args: string[]): Proc {
  const child = spawn("node", ["--import", "./register.mjs", "proc.mjs", ...args], {
    cwd: new URL("./node/", import.meta.url).pathname,
    env: { ...process.env, DH_DIR: dir, DH_ROLE: role, COLLIE_TOKEN: TOKEN },
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

describe("a real durable-harness session (spec 04 extends)", () => {
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
});

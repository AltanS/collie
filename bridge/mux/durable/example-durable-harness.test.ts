import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ControlRequest } from "../../types.ts";
import { DurableMux, SYSTEM_CLOCK } from "./adapter.ts";
import type { DurableEventSink } from "./events.ts";
import type { DurableEvent, DurablePane } from "./protocol.ts";
import { buildDurableTransport, chooseDurableTransport } from "./transport.ts";

// THE DURABLE-HARNESS EXAMPLE, DRIVEN BY THE REAL ADAPTER OVER THE HTTPS TRANSPORT (M66 spec 04).
// `examples/durable-harness/server.ts` is the shipping desk a person runs on Node: durable-harness on world-local, Pi's
// faux model, `collieRoute` under /collie behind a bearer token. This test starts it with `node` on a loopback port
// (the one plain-http exception of WIRE.md section 1B), seeds two sessions the way the README says, and drives the same
// adapter as example-cloudflare.test.ts through `chooseDurableTransport` and `buildDurableTransport`. No wrangler, no
// network, no key.
//
// It needs Node 23.6 or later on PATH (it runs the SDK's TypeScript source as it is) and the example's own install
// (`bun install --frozen-lockfile` in that folder; the CI job does it first), and it skips and says so without them.
// The token is made at run time and is never a literal in this file.

const EXAMPLE = join(import.meta.dir, "..", "..", "..", "examples", "durable-harness");
const NODE = Bun.which("node");

function nodeMajor(): number {
  if (NODE === null) return 0;
  const out = Bun.spawnSync([NODE, "--version"]).stdout.toString();
  return Number(/^v(\d+)/.exec(out)?.[1] ?? 0);
}

function skipReason(): string {
  if (process.platform === "win32") return "the durable-harness example test does not run on Windows";
  if (NODE === null) return "no node on PATH: the example runs on Node 23.6 or later";
  if (nodeMajor() < 23) return `node ${String(nodeMajor())} is too old to run the SDK's TypeScript source: use Node 23.6 or later`;
  if (!existsSync(join(EXAMPLE, "node_modules", "durable-harness"))) return "example deps not installed: run bun install --frozen-lockfile in examples/durable-harness";
  return "";
}
const SKIP_REASON = skipReason();
const RUNS = SKIP_REASON === "";
if (!RUNS) {
  // Bun prints no name for a skipped test, so the reason goes to the log as well.
  console.warn(`example-durable-harness.test.ts skipped: ${SKIP_REASON}`);
  test.skip(SKIP_REASON, () => {});
}

/** Every event the reader handed over, per pane, in order. */
class Recorder implements DurableEventSink {
  readonly batches = new Map<string, DurableEvent[][]>();
  apply(paneId: string, events: readonly DurableEvent[]): Promise<number> {
    const list = this.batches.get(paneId) ?? [];
    list.push([...events]);
    this.batches.set(paneId, list);
    return Promise.resolve(events.length);
  }
  all(paneId: string): DurableEvent[] {
    return (this.batches.get(paneId) ?? []).flat();
  }
}

async function until<T>(what: string, look: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const seen = await look();
    if (seen !== undefined) return seen;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** A free loopback port: open one on port 0, read its number, close it. */
function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  void listener.stop(true);
  return port;
}

describe.skipIf(!RUNS)("the durable-harness example against the real adapter over HTTPS transport", () => {
  const dir = RUNS ? mkdtempSync(join(tmpdir(), "collie-dh-")) : "";
  const port = RUNS ? freePort() : 0;
  const base = `http://127.0.0.1:${String(port)}`;
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const built = buildDurableTransport(chooseDurableTransport({ COLLIE_DURABLE_URL: `${base}/collie`, COLLIE_DURABLE_TOKEN: token }));
  const recorder = new Recorder();
  const adapter = new DurableMux(built.transport, SYSTEM_CLOCK, recorder);
  const log: string[] = [];
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let shipPane = "";
  let stockPane = "";

  /** The environment of both programs: the token and the data folder only. No key, no model id. */
  const env = () => ({
    ...process.env,
    COLLIE_TOKEN: token,
    PORT: String(port),
    HOST: "127.0.0.1",
    WORKFLOW_LOCAL_DATA_DIR: join(dir, ".workflow-data"),
    SEED_URL: base,
    PI_MODEL: undefined,
  });

  /** A pane as the adapter's last read shows it, after a fresh read. */
  async function pane(id: string): Promise<DurablePane | undefined> {
    await adapter.refresh();
    return adapter.program()?.snapshot.panes.find((candidate) => candidate.id === id);
  }

  beforeAll(async () => {
    // The loader flag maps Pi, durable-harness and @workflow/* to this example's install for the SDK's source (README).
    const spawned = Bun.spawn([NODE ?? "node", "--import", "./tests/node/register.mjs", "server.ts"], { cwd: EXAMPLE, env: env(), stdout: "pipe", stderr: "pipe" });
    child = spawned;
    for (const stream of [spawned.stdout, spawned.stderr]) {
      void (async () => {
        for await (const chunk of stream) log.push(new TextDecoder().decode(chunk));
      })();
    }
    const end = Date.now() + 45_000;
    for (;;) {
      if (spawned.exitCode !== null) throw new Error(`the server exited with ${String(spawned.exitCode)} before it answered; it printed:\n${log.join("").slice(-4000)}`);
      if (Date.now() > end) throw new Error(`no hello within 45 s; the server printed:\n${log.join("").slice(-4000)}`);
      const hello = await fetch(`${base}/collie/session/v1/hello`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) }).catch(() => null);
      if (hello?.status === 200) break;
      void hello?.body?.cancel();
      await Bun.sleep(300);
    }
    // The README's second step: `node seed.ts` starts two sessions on the running server.
    const seeded = Bun.spawnSync([NODE ?? "node", "seed.ts"], { cwd: EXAMPLE, env: env() });
    if (seeded.exitCode !== 0) throw new Error(`seed.ts exited with ${String(seeded.exitCode)}: ${seeded.stderr.toString()}`);
  }, 60_000);

  afterAll(async () => {
    if (child !== null) {
      child.kill("SIGTERM");
      const gone = await Promise.race([child.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
      if (!gone) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  }, 15_000);

  test("durable-harness: the transport is https, points at loopback under /collie and never shows the token", () => {
    expect(built.transport.kind).toBe("https");
    expect(built.description).toBe(`loopback http (wrangler dev) ${base}/collie with a bearer token (64 bytes)`);
    expect(built.description).not.toContain(token);
  });

  test("durable-harness: a request without the bearer header is 401 unauthorized, and so is a wrong token", async () => {
    const bare = await fetch(`${base}/collie/session/v1/hello`);
    expect(bare.status).toBe(401);
    expect(await bare.json()).toEqual({ code: "unauthorized" });
    expect(bare.headers.get("www-authenticate")).not.toBeNull();
    const wrong = await fetch(`${base}/collie/session/v1/hello`, { headers: { authorization: `Bearer ${"x".repeat(64)}` } });
    expect(wrong.status).toBe(401);
    void wrong.body?.cancel();
    // The chat route sits behind the same token.
    const chat = await fetch(`${base}/api/chat`, { method: "POST", body: JSON.stringify({ text: "hello" }) });
    expect(chat.status).toBe(401);
    void chat.body?.cancel();
  });

  test("durable-harness: hello agrees version 1, and the program is ready", async () => {
    expect((await adapter.poll()).ok).toBe(true);
    const session = adapter.program()?.session;
    expect(session?.version).toBe(1);
    expect(session?.hostName).toBe("desk");
    expect(session?.caps).toMatchObject({ asks: true, send: true, abort: true, history: true });
  });

  test("durable-harness: the seed's two sessions are listed, one waiting on an ask and one idle", async () => {
    const panes = await until("two panes", async () => {
      const mux = await adapter.snapshot();
      return mux.panes.length === 2 ? mux.panes : undefined;
    });
    expect(panes.every((p) => p.agent === "durable")).toBe(true);
    const ship = panes.find((p) => p.terminalTitle === "Please ship order 5521: the blue mug");
    const stock = panes.find((p) => p.terminalTitle === "How is the stock of the red mug?");
    expect([ship === undefined, stock === undefined]).toEqual([false, false]);
    shipPane = ship?.paneId ?? "";
    stockPane = stock?.paneId ?? "";
    const asks = await until("an open ask", async () => {
      await adapter.refresh();
      const open = adapter.openAsks(shipPane) ?? [];
      return open.length === 1 ? open : undefined;
    });
    expect(asks[0]?.options.map((option) => option.id)).toEqual(["allow", "deny"]);
    expect(asks[0]?.title).toBe("ship wants to run");
    expect((await pane(shipPane))?.state).toBe("waiting");
    await until("the stock session idle", async () => ((await pane(stockPane))?.state === "idle" ? true : undefined));
  });

  test("durable-harness: the events reader reads the pane's events, then only the newer ones", async () => {
    await adapter.syncEvents();
    const first = recorder.all(shipPane);
    expect(first.some((event) => event.type === "item" && event.item.kind === "user" && event.item.text === "Please ship order 5521: the blue mug")).toBe(true);
    expect(first.some((event) => event.type === "ask")).toBe(true);
    const before = recorder.batches.get(shipPane)?.length ?? 0;
    await adapter.syncEvents();
    expect(recorder.batches.get(shipPane)?.length ?? 0).toBe(before);
  });

  test("durable-harness: an allow from the adapter runs the tool once, decided by the phone, and a repeat replays", async () => {
    const shipped = join(dir, "shipped.txt");
    expect(existsSync(shipped)).toBe(false); // nothing ships before the phone says yes
    const ask = adapter.openAsks(shipPane)?.[0];
    if (ask === undefined) throw new Error("no open ask");
    const answer = { requestId: crypto.randomUUID(), askId: ask.id, revision: ask.revision, optionId: "allow" };
    expect(await adapter.answerAsk(shipPane, answer)).toEqual({ ok: true, value: { kind: "taken", replayed: false } });
    expect(await adapter.answerAsk(shipPane, answer)).toEqual({ ok: true, value: { kind: "taken", replayed: true } });
    await until("the ship session idle", async () => ((await pane(shipPane))?.state === "idle" ? true : undefined), 15_000);
    expect(readFileSync(shipped, "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(shipped, "utf8")).toContain("Please ship order 5521: the blue mug");
    await adapter.syncEvents();
    const after = recorder.all(shipPane);
    // This host derives its events from the log, so a read after a change is a reset view: it holds the items as they
    // stand and no `ask-closed` of the past. The receipt is the answer to a second, different request for the same ask.
    const second = { requestId: crypto.randomUUID(), askId: ask.id, revision: ask.revision, optionId: "deny" };
    expect(await adapter.answerAsk(shipPane, second)).toMatchObject({ ok: true, value: { kind: "too-late", replayed: false, decided: { by: "phone" } } });
    expect(after.some((event) => event.type === "item" && event.item.kind === "reply" && event.item.text.startsWith("Done: shipped:"))).toBe(true);
    expect(readFileSync(shipped, "utf8").trim().split("\n")).toHaveLength(1); // the late deny did not undo it, and nothing ran twice
  }, 30_000);

  test("durable-harness: a send to an idle session is accepted with a receipt, the same request id replays, and the turn runs", async () => {
    const idleTurn = (await pane(stockPane))?.turnId ?? "";
    const sendId = crypto.randomUUID();
    const send: ControlRequest = { act: "send", requestId: sendId, target: { kind: "turn", id: idleTurn }, text: "thank you", steer: false };
    expect(await adapter.controlTurn(stockPane, send)).toEqual({ kind: "ok", replayed: false });
    expect(await adapter.controlTurn(stockPane, send)).toEqual({ kind: "ok", replayed: true });
    await until("the reply", async () => {
      await adapter.refresh(); // the events reader reads the panes the last snapshot shows changed
      await adapter.syncEvents();
      return recorder.all(stockPane).some((event) => event.type === "item" && event.item.kind === "reply" && event.item.text === "Noted: thank you") ? true : undefined;
    }, 15_000);
    await until("idle again", async () => ((await pane(stockPane))?.state === "idle" ? true : undefined));
    const users = recorder.all(stockPane).flatMap((event) => (event.type === "item" && event.item.kind === "user" ? [event.item.text] : []));
    expect(users.filter((text) => text === "thank you")).toHaveLength(1); // the replay wrote nothing new
  }, 30_000);
});

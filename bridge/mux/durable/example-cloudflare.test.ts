import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ControlRequest } from "../../types.ts";
import { DurableMux, SYSTEM_CLOCK } from "./adapter.ts";
import type { DurableEventSink } from "./events.ts";
import type { DurableEvent, DurablePane } from "./protocol.ts";
import { buildDurableTransport, chooseDurableTransport } from "./transport.ts";

// THE CLOUDFLARE EXPERIMENT, DRIVEN BY THE REAL ADAPTER OVER THE HTTPS TRANSPORT (M50 spec 13).
// `experiments/durable-member-cloudflare` is the program a person deploys behind a bearer token. It moved out of
// examples/ in M55 spec 04: it is experimental and in no CI job, so this test runs only when a person sets
// COLLIE_CLOUDFLARE_EXPERIMENT=1 after `npm ci` in that folder. CI does not set it. This runs
// it under `wrangler dev` on 127.0.0.1 (the one plain-http exception of WIRE.md section 1B) and drives
// the same adapter as example.test.ts through `chooseDurableTransport` and `buildDurableTransport`, so
// the URL rule, the token rule, the HTTP client and the Worker agree on the bytes.
//
// It needs the flag, the experiment's own install (`npm ci` in that folder) and a Node on PATH, so without them it
// skips and says so. It skips on Windows, where wrangler's process group cannot be stopped this way.
//
// The token reaches wrangler through an `--env-file` in a 0700 temp folder, as `smoke.ts` does, and
// not through `--var`, which would put it on the command line where `ps` shows it. The token is made
// at run time and is never a literal in this file.

const EXAMPLE = join(import.meta.dir, "..", "..", "..", "experiments", "durable-member-cloudflare");
const WRANGLER = join(EXAMPLE, "node_modules", ".bin", "wrangler");
const NODE = Bun.which("node");

function skipReason(): string {
  if (process.env.COLLIE_CLOUDFLARE_EXPERIMENT !== "1") return "the Cloudflare experiment is not in CI: set COLLIE_CLOUDFLARE_EXPERIMENT=1 to run it";
  if (process.platform === "win32") return "the Cloudflare example test does not run on Windows";
  if (NODE === null) return "no node on PATH: wrangler needs Node 22 or later";
  if (!existsSync(WRANGLER)) return "example deps not installed: run npm ci in experiments/durable-member-cloudflare";
  return "";
}
const SKIP_REASON = skipReason();
const RUNS = SKIP_REASON === "";
if (!RUNS) {
  // Bun prints no name for a skipped test, so the reason goes to the log as well.
  console.warn(`example-cloudflare.test.ts skipped: ${SKIP_REASON}`);
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

async function until<T>(what: string, look: () => Promise<T | undefined>, ms = 5000): Promise<T> {
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

/** True when something accepts a connection on the port. */
async function listening(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!RUNS)("the Cloudflare example against the real adapter over HTTPS transport", () => {
  const dir = RUNS ? mkdtempSync(join(tmpdir(), "collie-dmcf-")) : "";
  const port = RUNS ? freePort() : 0;
  const base = `http://127.0.0.1:${String(port)}`;
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const built = buildDurableTransport(chooseDurableTransport({ COLLIE_DURABLE_URL: base, COLLIE_DURABLE_TOKEN: token }));
  const recorder = new Recorder();
  const adapter = new DurableMux(built.transport, SYSTEM_CLOCK, recorder);
  const log: string[] = [];
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let ticket = "";

  /** Stop wrangler and the workerd it started: they share a process group. */
  const killGroup = (signal: NodeJS.Signals) => {
    if (child === null) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // the group is already gone
    }
  };
  const onExit = () => killGroup("SIGKILL");

  /** A pane as the adapter's last read shows it, after a fresh read. */
  async function pane(id: string): Promise<DurablePane | undefined> {
    await adapter.refresh();
    return adapter.program()?.snapshot.panes.find((candidate) => candidate.id === id);
  }

  beforeAll(async () => {
    // 0700 folder, 0600 env file. DM_STEP_MS=0 makes the scripted answers instant; DM_SLOW_MS stays at
    // its default of ten seconds, so a follow-up leaves a run to stop.
    const envFile = join(dir, "test.env");
    writeFileSync(envFile, `COLLIE_TOKEN=${token}\nDM_STEP_MS=0\n`, { mode: 0o600 });
    const spawned = Bun.spawn(
      [
        WRANGLER,
        "dev",
        "--local",
        "--port",
        String(port),
        "--ip",
        "127.0.0.1",
        "--inspector-port",
        "0",
        "--show-interactive-dev-session=false",
        "--env-file",
        envFile,
        "--persist-to",
        join(dir, "state"),
      ],
      { cwd: EXAMPLE, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdout: "pipe", stderr: "pipe", detached: true },
    );
    child = spawned;
    process.on("exit", onExit);
    for (const stream of [spawned.stdout, spawned.stderr]) {
      void (async () => {
        for await (const chunk of stream) log.push(new TextDecoder().decode(chunk));
      })();
    }
    const end = Date.now() + 45_000;
    for (;;) {
      if (spawned.exitCode !== null) throw new Error(`wrangler exited with ${String(spawned.exitCode)} before it answered; it printed:\n${log.join("").slice(-4000)}`);
      if (Date.now() > end) throw new Error(`no hello within 45 s; wrangler printed:\n${log.join("").slice(-4000)}`);
      const hello = await fetch(`${base}/session/v1/hello`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) }).catch(() => null);
      if (hello?.status === 200) break;
      void hello?.body?.cancel();
      await Bun.sleep(300);
    }
  }, 50_000);

  afterAll(async () => {
    if (child !== null) {
      killGroup("SIGTERM");
      const gone = await Promise.race([child.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
      if (!gone) {
        killGroup("SIGKILL");
        await child.exited;
      }
      process.off("exit", onExit);
      // Workerd is wrangler's child: give it a moment, then the port must be free.
      const end = Date.now() + 3000;
      while ((await listening(port)) && Date.now() < end) await Bun.sleep(100);
      const stillOpen = await listening(port);
      if (stillOpen) killGroup("SIGKILL");
      if (dir !== "") rmSync(dir, { recursive: true, force: true });
      expect(stillOpen).toBe(false);
    } else if (dir !== "") {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("cloudflare: the transport is https, points at loopback and never shows the token", () => {
    expect(built.transport.kind).toBe("https");
    expect(built.description).toBe(`loopback http (wrangler dev) ${base} with a bearer token (64 bytes)`);
    expect(built.description).not.toContain(token);
  });

  test("cloudflare: a request without the bearer header is 401 unauthorized, and so is a wrong token", async () => {
    const bare = await fetch(`${base}/session/v1/hello`);
    expect(bare.status).toBe(401);
    expect(await bare.json()).toEqual({ code: "unauthorized" });
    expect(bare.headers.get("www-authenticate")).not.toBeNull();
    const wrong = await fetch(`${base}/session/v1/hello`, { headers: { authorization: `Bearer ${"x".repeat(64)}` } });
    expect(wrong.status).toBe(401);
    void wrong.body?.cancel();
  });

  test("cloudflare: hello agrees version 1, and the program is ready with every cap", async () => {
    expect((await adapter.poll()).ok).toBe(true);
    const session = adapter.program()?.session;
    expect(session?.version).toBe(1);
    expect(session?.hostName).toBe("durable-member-cloudflare");
    expect(session?.caps).toEqual({ asks: true, starters: true, send: true, steer: true, abort: true, rename: true, close: true, actions: true, history: true, reopen: true });
  });

  test("cloudflare: the snapshot holds the ticket a first start opens, and it waits on one ask", async () => {
    const mux = await adapter.snapshot();
    expect(mux.panes.length).toBeGreaterThanOrEqual(1);
    const first = mux.panes[0];
    expect(first?.agent).toBe("durable");
    expect(first?.tabLabel).toBe("Tickets");
    expect(first?.terminalTitle).toBe("Maria Lopez");
    ticket = first?.paneId ?? "";
    const asks = await until("an open ask", async () => {
      await adapter.refresh();
      const open = adapter.openAsks(ticket) ?? [];
      return open.length === 1 ? open : undefined;
    });
    expect(asks[0]?.options.map((option) => option.id)).toEqual(["allow", "deny"]);
    expect((await pane(ticket))?.state).toBe("waiting");
  });

  test("cloudflare: the events reader reads the pane's events, then only the newer ones", async () => {
    await adapter.syncEvents();
    const first = recorder.all(ticket);
    expect(first.some((event) => event.type === "item" && event.item.kind === "user" && event.item.text.startsWith("Maria Lopez writes:"))).toBe(true);
    expect(first.some((event) => event.type === "ask")).toBe(true);
    expect(first.some((event) => event.type === "reset")).toBe(false);
    const before = recorder.batches.get(ticket)?.length ?? 0;
    await adapter.syncEvents();
    expect(recorder.batches.get(ticket)?.length ?? 0).toBe(before);
  });

  test("cloudflare: an allow runs the tool once, and a repeat with the same request id replays", async () => {
    const ask = adapter.openAsks(ticket)?.[0];
    if (ask === undefined) throw new Error("no open ask");
    const answer = { requestId: crypto.randomUUID(), askId: ask.id, revision: ask.revision, optionId: "allow" };
    expect(await adapter.answerAsk(ticket, answer)).toEqual({ ok: true, value: { kind: "taken", replayed: false } });
    expect(await adapter.answerAsk(ticket, answer)).toEqual({ ok: true, value: { kind: "taken", replayed: true } });
    await until("the ticket idle", async () => ((await pane(ticket))?.state === "idle" ? true : undefined), 15_000);
    // The look-up answered and closed itself, so no pane is left under Look-ups.
    expect(adapter.program()?.snapshot.panes.some((candidate) => candidate.tabId === "triage:helpers")).toBe(false);
    await adapter.syncEvents();
    const after = recorder.all(ticket);
    expect(after.filter((event) => event.type === "ask-closed" && event.by === "phone")).toHaveLength(1);
    expect(after.some((event) => event.type === "item" && event.item.kind === "reply" && event.item.text.startsWith("Found it."))).toBe(true);
  });

  test("cloudflare: a send starts a new turn, and a stop ends it with a settled event and no item", async () => {
    const oldTurn = (await pane(ticket))?.turnId ?? "";
    const sendId = crypto.randomUUID();
    const send: ControlRequest = { act: "send", requestId: sendId, target: { kind: "turn", id: oldTurn }, text: "one more thing", steer: false };
    expect(await adapter.controlTurn(ticket, send)).toEqual({ kind: "ok", replayed: false });
    const working = await until("a new turn", async () => {
      const seen = await pane(ticket);
      return seen?.state === "working" && seen.turnId !== oldTurn ? seen : undefined;
    });
    const abort: ControlRequest = { act: "abort", requestId: crypto.randomUUID(), target: { kind: "turn", id: working.turnId } };
    expect(await adapter.controlTurn(ticket, abort)).toEqual({ kind: "ok", replayed: false });
    await until("idle after the stop", async () => ((await pane(ticket))?.state === "idle" ? true : undefined), 15_000);
    await adapter.syncEvents();
    const events = recorder.all(ticket);
    expect(events).toContainEqual({ type: "settled", inputId: expect.any(String), requestId: sendId, status: "unanswered", reason: "aborted" });
    const sent = events.findIndex((event) => event.type === "item" && event.item.kind === "user" && event.item.text === "one more thing");
    expect(sent).toBeGreaterThan(-1);
    // The stop adds no item of its own: no notice, and no reply except the one that was growing, which ends where it was cut
    // (the same id again, its last version without partial: WIRE.md 7.5 and 7.15).
    const after = events.slice(sent + 1).flatMap((event) => (event.type === "item" ? [event.item] : []));
    expect(after.some((item) => item.kind === "notice")).toBe(false);
    const replies = after.filter((item) => item.kind === "reply");
    expect(new Set(replies.map((item) => item.id)).size).toBeLessThanOrEqual(1);
    expect(replies.length === 0 || !("partial" in (replies.at(-1) ?? {}))).toBe(true);
  });

  test("cloudflare: a starter opens a new pane, and a repeat with the same request id opens nothing", async () => {
    const listed = await adapter.listStarters();
    expect(listed.starters.map((starter) => starter.id)).toContain("sign-in");
    const requestId = crypto.randomUUID();
    const started = await adapter.startStarter("sign-in", requestId);
    if (started.kind !== "started") throw new Error(`the starter did not start: ${JSON.stringify(started)}`);
    expect(started.replayed).toBe(false);
    expect(started.paneId).not.toBe(ticket);
    expect(adapter.program()?.snapshot.panes.some((candidate) => candidate.id === started.paneId)).toBe(true);
    expect(await adapter.startStarter("sign-in", requestId)).toEqual({ kind: "started", paneId: started.paneId, replayed: true });
    expect(adapter.program()?.snapshot.panes.filter((candidate) => candidate.tabId === "triage:inbox")).toHaveLength(2);
  });
  test("cloudflare: history lists the ticket and its items from the program, and a close then a reopen bring it back", async () => {
    // Run alone (a `-t` filter), the earlier tests did not name the ticket: find the first one under Tickets.
    if (ticket === "") {
      ticket = await until("the first ticket", async () => {
        await adapter.refresh();
        return adapter.program()?.snapshot.panes.find((candidate) => candidate.tabId === "triage:inbox")?.id;
      });
    }
    await adapter.refresh();
    expect(adapter.capabilities.supports.programHistory).toBe(true);
    expect(adapter.capabilities.supports.reopenConversation).toBe(true);
    const list = await adapter.listConversations({});
    if (!list.ok) throw new Error(list.detail);
    const row = list.value.items.find((item) => item.id === ticket);
    expect(row).toMatchObject({ state: "open", paneId: ticket, workspaceId: "triage", tabId: "triage:inbox" });
    const items = await adapter.conversationItems(ticket, {});
    if (!items.ok) throw new Error(items.detail);
    expect(items.value.items.length).toBe(row?.items ?? -1);
    expect(items.value.items.some((item) => item.kind === "user")).toBe(true);
    expect(await adapter.conversationItems("conv-99999", {})).toMatchObject({ ok: false, reason: "gone" });

    expect(await adapter.closePane(ticket)).toEqual({ ok: true, value: undefined });
    const closed = await adapter.listConversations({});
    if (!closed.ok) throw new Error(closed.detail);
    expect(closed.value.items.find((item) => item.id === ticket)).toMatchObject({ state: "closed" });
    expect(closed.value.items.find((item) => item.id === ticket)?.paneId).toBeUndefined();
    // The closed conversation is still served whole, by the program.
    const kept = await adapter.conversationItems(ticket, {});
    expect(kept.ok && kept.value.items.map((item) => item.id)).toEqual(items.value.items.map((item) => item.id));

    expect(await adapter.reopenConversation(ticket)).toEqual({ ok: true, value: { paneId: ticket } });
    expect(adapter.program()?.snapshot.panes.some((candidate) => candidate.id === ticket)).toBe(true);
  }, 20_000);
});

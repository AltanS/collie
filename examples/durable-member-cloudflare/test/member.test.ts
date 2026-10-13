// The Worker and its Durable Object inside workerd, through Cloudflare's Vitest plugin. The tests share one
// object and run in order, as a phone and a peer would: token, hello, the first ticket and its ask, an answer,
// a starter, a send and a stop, then restarts. `abortAllDurableObjects()` throws the object away and keeps its
// storage, which is what a deploy or an eviction does: the next request runs the constructor again.
// Under `npm run test:memory` Pi keeps its conversations in memory, so the two tests that need them to survive a
// restart are skipped; the request ids live in the example's own SQLite table either way.
import { env as bindings, exports } from "cloudflare:workers";
import { abortAllDurableObjects, listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { PaneRegistry } from "../../durable-member/pi-durable/index.ts";
import { askIdFor, createCore, HttpError, Receipts } from "../../durable-member/sdk/core/index.ts";
import type { Env } from "../src/env.ts";
import { DROPPED_KEPT, RECEIPTS_KEPT, SqliteReceiptStore } from "../src/receipts.ts";
import { tokenAccepted } from "../src/token.ts";

const env = bindings as unknown as Env;
const worker = (exports as unknown as { default: Fetcher }).default;

const TOKEN = env.COLLIE_TOKEN!;
const SQLITE = env.DM_STORAGE !== "memory";

interface Reply {
  status: number;
  etag: string | null;
  body: any;
}

async function call(method: string, path: string, o: { body?: unknown; token?: string | null; version?: number | null; headers?: Record<string, string> } = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...o.headers };
  const token = o.token === undefined ? TOKEN : o.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const version = o.version === undefined ? 1 : o.version;
  if (version !== null) headers["x-collie-session"] = String(version);
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const res = await worker.fetch(
    new Request(`https://member.example/session/v1${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }),
  );
  const text = await res.text();
  return { status: res.status, etag: res.headers.get("etag"), body: text ? JSON.parse(text) : undefined };
}

const snapshot = async () => (await call("GET", "/snapshot")).body;
const paneOf = async (id: string) => (await snapshot()).panes.find((p: { id: string }) => p.id === id);
const events = async (pane: string, after: number, epoch: string) => (await call("GET", `/pane/${encodeURIComponent(pane)}/events?after=${after}&epoch=${epoch}`)).body;

async function waitFor<T>(what: string, look: () => Promise<T | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const seen = await look();
    if (seen) return seen;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The first ticket in the Inbox, once its ask is open. */
const firstTicket = () =>
  waitFor("the first ticket's ask", async () => (await snapshot()).panes.find((p: any) => p.tabId === "triage:inbox" && p.openAsks.length > 0));

const notes = () => runInDurableObject(env.MEMBER.getByName("main"), (_o, state) => state.storage.sql.exec<{ note: string }>("SELECT note FROM collie_notes").toArray());

describe("the bearer token", () => {
  test("a missing or wrong token is 401 unauthorized, before the version check and before any Durable Object exists", async () => {
    expect(await listDurableObjectIds(env.MEMBER)).toHaveLength(0);
    for (const o of [
      { token: null },
      { token: "wrong" },
      { token: `${TOKEN}x` },
      { token: TOKEN.slice(0, -1) },
      { token: null, headers: { authorization: `Basic ${TOKEN}` } },
      { token: null, headers: { authorization: TOKEN } },
      { token: null, version: 99 },
    ]) {
      const r = await call("GET", "/hello", o);
      expect([JSON.stringify(o), r.status, r.body]).toEqual([JSON.stringify(o), 401, { code: "unauthorized" }]);
    }
    expect((await call("POST", "/starter/new-triage", { token: "wrong", body: { requestId: "r" } })).status).toBe(401);
    expect(await listDurableObjectIds(env.MEMBER)).toHaveLength(0); // nothing woke
  });

  test("the right token passes, and the scheme is not case-sensitive", async () => {
    expect((await call("GET", "/hello")).status).toBe(200);
    expect((await call("GET", "/hello", { token: null, headers: { authorization: `bearer ${TOKEN}` } })).status).toBe(200);
    expect(await listDurableObjectIds(env.MEMBER)).toHaveLength(1); // one program, one object
  });
  test("a rotation: COLLIE_TOKEN and COLLIE_TOKEN_NEXT both pass while both are set, and nothing else does", async () => {
    const next = env.COLLIE_TOKEN_NEXT!;
    expect((await call("GET", "/hello", { token: next })).status).toBe(200);
    expect((await call("GET", "/hello", { token: `${next}x` })).status).toBe(401);
    const asked = (token: string) => new Request("https://member.example/", { headers: { authorization: `Bearer ${token}` } });
    expect(await tokenAccepted(asked(TOKEN), TOKEN, undefined)).toBe(true);
    expect(await tokenAccepted(asked(next), TOKEN, undefined)).toBe(false); // the rotation ended: the old next is refused
    expect(await tokenAccepted(asked(next), undefined, next)).toBe(true);
    expect(await tokenAccepted(asked("short"), TOKEN, "short")).toBe(false); // a next under 32 bytes is never used
    expect(await tokenAccepted(asked(""), undefined, undefined)).toBe(false);
  });
});

describe("the wire", () => {
  test("hello says collie-durable, the range, the host, ready and the caps; with a token, a bad version is 409", async () => {
    const r = await call("GET", "/hello", { version: null });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      service: "collie-durable",
      protocol: { min: 1, max: 1 },
      host: { name: "durable-member-cloudflare" },
      ready: true,
      caps: { asks: true, starters: true, send: true, steer: true, abort: true, terminal: false },
    });
    expect(r.body.epoch).toMatch(/^[0-9a-f]{32}$/);
    expect((await call("GET", "/snapshot", { version: 2 })).body).toEqual({ code: "incompatible", range: { min: 1, max: 1 } });
  });

  test("the snapshot lays out Triage, Inbox and Helpers, the first ticket waits on an Allow or Deny ask, and the ETag gives 304", async () => {
    const pane = await firstTicket();
    const s = await snapshot();
    expect(s.workspaces).toEqual([{ id: "triage", title: "Triage", cwd: "/srv/triage" }]);
    expect(s.tabs.map((t: { title: string }) => t.title)).toEqual(["Inbox", "Helpers"]);
    expect(s.starters).toEqual([
      { id: "new-triage", label: "New triage" },
      { id: "two-notes", label: "Two notes at once (faux only)" },
    ]);
    expect(pane.state).toBe("waiting");
    expect(pane.openAsks[0].options.map((o: { effect: string }) => o.effect)).toEqual(["allow", "deny"]);
    const first = await call("GET", "/snapshot");
    expect(first.etag).toBe(`"${first.body.epoch}-${first.body.rev}"`);
    expect((await call("GET", "/snapshot", { headers: { "if-none-match": first.etag! } })).status).toBe(304);
    expect((await call("GET", "/snapshot", { headers: { "if-none-match": `W/${first.etag}` } })).status).toBe(304);
  });

  test("an answer runs once: a repeat replays, the note is written once, a helper answers and the ticket replies", async () => {
    const pane = await firstTicket();
    const ask = pane.openAsks[0];
    const body = { requestId: "answer-1", askId: ask.id, revision: ask.revision, answer: { optionId: "allow" } };
    expect((await call("POST", `/pane/${pane.id}/answer`, { body })).body).toEqual({ result: "taken" });
    expect((await call("POST", `/pane/${pane.id}/answer`, { body })).body).toEqual({ result: "taken", replayed: true });
    expect((await call("POST", `/pane/${pane.id}/answer`, { body: { ...body, answer: { optionId: "deny" } } })).body).toEqual({ code: "request-id-reused" });
    const done = await waitFor("the ticket's reply", async () => {
      const r = await events(pane.id, 0, "none");
      return r.events.some((e: any) => e.type === "item" && e.item.kind === "reply" && e.item.text.startsWith("Triage done.")) && r;
    });
    expect(done.reset).toBe(true);
    expect((await snapshot()).panes.some((p: any) => p.tabId === "triage:helpers")).toBe(true);
    expect((await notes()).map((n) => n.note)).toEqual(["Ticket 412: login failure after password reset."]);
    expect((await paneOf(pane.id)).state).toBe("idle");
  });

  test("send starts a turn on the idle ticket, and abort with the turn id stops it: the input settles unanswered", async () => {
    const pane = (await snapshot()).panes.find((p: any) => p.tabId === "triage:inbox");
    const before = await events(pane.id, 0, "none");
    const sent = await call("POST", `/pane/${pane.id}/send`, { body: { requestId: "send-1", text: "Any update?", turnId: pane.turnId } });
    expect(sent.body).toEqual({ ok: true });
    const working = await waitFor("the slow answer to start", async () => {
      const p = await paneOf(pane.id);
      return p.state === "working" && p;
    });
    expect(working.turnId).not.toBe(pane.turnId);
    expect((await call("POST", `/pane/${pane.id}/send`, { body: { requestId: "send-2", text: "x", turnId: pane.turnId } })).body.code).toBe("stale");
    expect((await call("POST", `/pane/${pane.id}/abort`, { body: { requestId: "abort-1", turnId: working.turnId } })).body).toEqual({ ok: true });
    const settled = await waitFor("the stopped input to settle", async () => {
      const r = await events(pane.id, before.next, before.epoch);
      return r.events.find((e: any) => e.type === "settled" && e.status === "unanswered");
    });
    expect(settled.reason).toBe("aborted");
    await waitFor("idle", async () => (await paneOf(pane.id)).state === "idle");
  });

  test("a starter opens a new ticket; the same request id replays the same pane and opens nothing", async () => {
    const count = (await snapshot()).panes.length;
    const r = await call("POST", "/starter/new-triage", { body: { requestId: "start-1" } });
    expect(r.status).toBe(200);
    expect((await call("POST", "/starter/new-triage", { body: { requestId: "start-1" } })).body).toEqual({ paneId: r.body.paneId, replayed: true });
    const s = await snapshot();
    expect(s.panes.length).toBe(count + 1);
    expect(s.panes.some((p: { id: string }) => p.id === r.body.paneId)).toBe(true);
    await waitFor("the new ticket's ask", async () => (await paneOf(r.body.paneId)).openAsks.length > 0);
  });
});

describe("the real model's key", () => {
  test("a binding is readable as process.env, which is where Pi looks for OPENROUTER_API_KEY", () => {
    // nodejs_compat fills process.env from the Worker's bindings, secrets included. The token is one, so it shows.
    expect(process.env.COLLIE_TOKEN).toBe(TOKEN);
  });
});

describe("a restart", () => {
  test("a new epoch: an old cursor gets a reset reply, and the request ids survive in SQLite", async () => {
    const before = (await call("GET", "/hello")).body.epoch;
    const ticket = (await snapshot()).panes.find((p: any) => p.tabId === "triage:inbox");
    const cursor = (await events(ticket.id, 0, before)).next;
    await abortAllDurableObjects();
    const after = (await call("GET", "/hello")).body;
    expect(after.epoch).not.toBe(before);
    expect(after.ready).toBe(true);
    // Every receipt from before the restart still replays and runs nothing. The bodies are the same as the first time.
    expect((await call("POST", "/starter/new-triage", { body: { requestId: "start-1" } })).body.replayed).toBe(true);
    if (!SQLITE) return; // in memory, Pi's conversations are gone, and so are the panes
    const panes = (await snapshot()).panes;
    expect(panes.some((p: { id: string }) => p.id === ticket.id)).toBe(true); // a pane id is the conversation id
    const r = await events(ticket.id, cursor, before);
    expect(r.reset).toBe(true);
    expect(r.epoch).toBe(after.epoch);
    expect(r.events[0]).toEqual({ type: "reset" });
    expect(r.events.some((e: any) => e.type === "item" && e.item.kind === "reply" && e.item.text.startsWith("Triage done."))).toBe(true);
    expect((await notes()).length).toBe(1); // the note was not written again
  });

  test.skipIf(!SQLITE)("a wake keeps the ask: raised again before ready, with the same id, and a tap sent across it is taken once", async () => {
    const r = await call("POST", "/starter/new-triage", { body: { requestId: "start-2" } });
    const paneId = r.body.paneId;
    const old = await waitFor("an ask", async () => (await paneOf(paneId)).openAsks[0]);
    const notesBefore = (await notes()).length;
    await abortAllDurableObjects();
    // No wait: the first snapshot after the wake carries the ask, because the object raises it before ready.
    const again = (await paneOf(paneId)).openAsks[0];
    expect(again).toMatchObject({ id: old.id, toolCallId: old.toolCallId, revision: 1 });
    // The tap the phone sent with the id it listed before the wake lands on the raised ask.
    const tap = { requestId: "answer-across-wake", askId: old.id, revision: old.revision, answer: { optionId: "allow" } };
    expect((await call("POST", `/pane/${paneId}/answer`, { body: tap })).body).toEqual({ result: "taken" });
    expect((await call("POST", `/pane/${paneId}/answer`, { body: tap })).body).toEqual({ result: "taken", replayed: true });
    await waitFor("the ticket to finish", async () => (await paneOf(paneId)).state === "idle");
    expect((await notes()).length).toBe(notesBefore + 1); // the tool ran once
  });
});

/**
 * The start path of member.ts after a wake, without Pi: the registry has seen a risky call with no result (the
 * mapper replays it from storage before resume()), and the harness then raises its ask, late, or never.
 */
describe("a wake whose harness is late", () => {
  const risky = new Set(["write_note"]);
  const options = [
    { id: "allow", label: "Allow", effect: "allow" as const },
    { id: "deny", label: "Deny", effect: "deny" as const },
  ];
  const wake = () => {
    const core = createCore({ hostName: "wake", allowAlways: false });
    const pane = core.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p", { title: "P", harness: "pi" });
    const panes = new PaneRegistry();
    const raise = (callId: string) => {
      const answer = pane.ask({ kind: "permission", toolCallId: callId, itemId: callId, title: "write_note wants to run", options });
      panes.asked(callId);
      return answer;
    };
    const read = async (path: string, init: RequestInit = {}) => {
      const res = await core.handle(new Request(`https://member.example/session/v1${path}`, { ...init, headers: { "x-collie-session": "1", "content-type": "application/json" } }));
      return { status: res.status, body: (await res.json()) as any };
    };
    return { core, panes, raise, read };
  };

  test("the harness raises nothing: the start goes ready when the window ends, logs once, and no request waits; a late raise is listed under its old id", async () => {
    const { core, panes, raise, read } = wake();
    panes.toolStatus("call-1", "write_note", "running");
    const logs: string[] = [];
    const window = panes.reRaised(risky, 100, (line) => logs.push(line));
    // While the start waits, hello answers at once and says not ready: nothing queues behind the wait.
    expect((await read("/hello")).body.ready).toBe(false);
    await window; // resolves: the harness raised nothing, and the window is the bound
    core.ready();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("within 100 ms");
    expect(logs[0]).toContain("call-1");
    const first = (await read("/snapshot")).body.panes[0];
    expect([first.state, first.openAsks]).toEqual(["idle", []]);

    // The hook runs after ready: the ask appears under the id it had before the wake, and an answer to it lands.
    const answer = raise("call-1");
    const listed = (await read("/snapshot")).body.panes[0];
    expect(listed.state).toBe("waiting");
    expect(listed.openAsks.map((a: { id: string; revision: number }) => [a.id, a.revision])).toEqual([[askIdFor("p", "call-1"), 1]]);
    const tap = { requestId: "late-tap", askId: askIdFor("p", "call-1"), revision: 1, answer: { optionId: "allow" } };
    expect((await read("/pane/p/answer", { method: "POST", body: JSON.stringify(tap) })).body).toEqual({ result: "taken" });
    expect(await answer).toEqual({ optionId: "allow" });
    expect(logs).toHaveLength(1); // once per start, not once per late ask
  });

  test("the harness raises inside the window: the start waits for it, logs nothing, and the first snapshot lists the ask", async () => {
    const { core, panes, raise, read } = wake();
    panes.toolStatus("call-2", "write_note", "running");
    panes.toolStatus("call-3", "write_note", "running");
    const logs: string[] = [];
    const window = panes.reRaised(risky, 5000, (line) => logs.push(line));
    setTimeout(() => {
      void raise("call-2");
      panes.toolStatus("call-3", "write_note", "done"); // a call that ended while the object slept holds nothing back
    }, 10);
    await window;
    core.ready();
    expect(logs).toEqual([]);
    const first = (await read("/snapshot")).body.panes[0];
    expect(first.openAsks.map((a: { id: string }) => a.id)).toEqual([askIdFor("p", "call-2")]);
  });
});

describe("the receipts cap", () => {
  test("the newest 1000 per pane are kept; replaying the first of 1001 is refused (an unknown outcome) and runs nothing", async () => {
    await runInDurableObject(env.MEMBER.getByName("main"), async (_o, state) => {
      const store = new SqliteReceiptStore(state.storage);
      for (let i = 0; i <= RECEIPTS_KEPT; i++) store.put(`cap-${i}`, { digest: `d${i}`, reply: { ok: true } }, "cap-pane");
      store.put("cap-other", { digest: "d", reply: { ok: true } }, "cap-other-pane");
      expect(store.get("cap-0")).toEqual({ dropped: true, digest: "d0" });
      expect(store.get("cap-1")).toEqual({ digest: "d1", reply: { ok: true } });
      expect(store.get("cap-other")).toEqual({ digest: "d", reply: { ok: true } }); // another pane keeps its own
      const kept = state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM collie_receipts WHERE grp = 'cap-pane' AND dropped = 0").one().n;
      expect(kept).toBe(RECEIPTS_KEPT);
      let runs = 0;
      const receipts = new Receipts(store);
      const replay = receipts.run("cap-0", "d0", async () => (runs++, { ok: true }), "cap-pane");
      await expect(replay).rejects.toBeInstanceOf(HttpError);
      await expect(receipts.run("cap-0", "d0", async () => (runs++, { ok: true }), "cap-pane")).rejects.toMatchObject({ status: 500, code: "receipt-dropped" });
      expect(runs).toBe(0);
      expect(DROPPED_KEPT).toBe(10 * RECEIPTS_KEPT);
    });
  });
});

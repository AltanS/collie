// The Worker and its Durable Object inside workerd, through Cloudflare's Vitest plugin. The tests share one
// object and run in order, as a phone and a peer would: token, hello, the first ticket and its ask, an answer,
// a starter, a send and a stop, then restarts. `abortAllDurableObjects()` throws the object away and keeps its
// storage, which is what a deploy or an eviction does: the next request runs the constructor again.
// Under `npm run test:memory` Pi keeps its conversations in memory, so the two tests that need them to survive a
// restart are skipped; the request ids live in the example's own SQLite table either way.
import { env as bindings, exports } from "cloudflare:workers";
import { abortAllDurableObjects, listDurableObjectIds, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { PaneRegistry } from "../../../examples/durable-member/pi-durable/index.ts";
import { LONG_ANSWER_START, SIGN_IN_DONE } from "../../../examples/durable-member/script.ts";
import { askIdFor, createCore, HttpError, Receipts } from "../../../packages/durable-sdk/src/core/index.ts";
import type { Env } from "../src/env.ts";
import type { Member } from "../src/member.ts";
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

/** The first ticket under Tickets, once its ask is open. */
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
    expect((await call("POST", "/starter/sign-in", { token: "wrong", body: { requestId: "r" } })).status).toBe(401);
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
      caps: { asks: true, starters: true, send: true, steer: true, abort: true, rename: true, close: true, actions: true, history: true, reopen: true, terminal: false },
    });
    expect(r.body.epoch).toMatch(/^[0-9a-f]{32}$/);
    expect((await call("GET", "/snapshot", { version: 2 })).body).toEqual({
      code: "incompatible",
      range: { min: 1, max: 1 },
      refusal: { code: "version", collie: [2, 2], program: [1, 1] },
    });
  });

  test("the snapshot lays out Support, Tickets and Look-ups, the first ticket waits on a Save or Don't save ask, and the ETag gives 304", async () => {
    const pane = await firstTicket();
    const s = await snapshot();
    expect(s.workspaces).toEqual([{ id: "triage", title: "Support", cwd: "/srv/support" }]);
    expect(s.tabs.map((t: { title: string }) => t.title)).toEqual(["Tickets", "Look-ups"]);
    expect(s.starters).toEqual([
      { id: "sign-in", label: "Sign-in problem" },
      { id: "double-charge", label: "Double charge" },
      { id: "new-address", label: "Address change" },
    ]);
    expect(pane).toMatchObject({ state: "waiting", title: "Maria Lopez", subtitle: "Can't sign in after a password reset" });
    expect(pane.openAsks[0].title).toBe("Save this note to the ticket?");
    expect(pane.openAsks[0].options.map((o: { effect: string }) => o.effect)).toEqual(["allow", "deny"]);
    const first = await call("GET", "/snapshot");
    expect(first.etag).toBe(`"${first.body.epoch}-${first.body.rev}"`);
    expect((await call("GET", "/snapshot", { headers: { "if-none-match": first.etag! } })).status).toBe(304);
    expect((await call("GET", "/snapshot", { headers: { "if-none-match": `W/${first.etag}` } })).status).toBe(304);
  });

  test("an answer runs once: a repeat replays, the note is written once, a look-up answers and closes, and the ticket replies", async () => {
    const pane = await firstTicket();
    const ask = pane.openAsks[0];
    const body = { requestId: "answer-1", askId: ask.id, revision: ask.revision, answer: { optionId: "allow" } };
    expect((await call("POST", `/pane/${pane.id}/answer`, { body })).body).toEqual({ result: "taken" });
    expect((await call("POST", `/pane/${pane.id}/answer`, { body })).body).toEqual({ result: "taken", replayed: true });
    expect((await call("POST", `/pane/${pane.id}/answer`, { body: { ...body, answer: { optionId: "deny" } } })).body).toEqual({ code: "request-id-reused" });
    const done = await waitFor("the ticket's reply", async () => {
      const r = await events(pane.id, 0, "none");
      return r.events.some((e: any) => e.type === "item" && e.item.kind === "reply" && e.item.partial !== true && e.item.text.startsWith(SIGN_IN_DONE)) && r;
    });
    expect(done.reset).toBe(true);
    // The look-up closed itself once it answered: no pane, and the history lists it closed.
    expect((await snapshot()).panes.some((p: any) => p.tabId === "triage:helpers")).toBe(false);
    const lookup = (await call("GET", "/conversations")).body.items.find((x: { tabId: string }) => x.tabId === "triage:helpers");
    expect(lookup).toMatchObject({ title: "Look-up for Maria Lopez", state: "closed" });
    expect((await notes()).map((n) => n.note)).toEqual(["Sign-in fails after a password reset. The old session may still be active."]);
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

  test("a reply grows under one id while the program writes it, and a stop leaves the last version without partial", async () => {
    const pane = (await snapshot()).panes.find((p: any) => p.tabId === "triage:inbox");
    const before = await events(pane.id, 0, "none");
    expect((await call("POST", `/pane/${pane.id}/send`, { body: { requestId: "stream-1", text: "Go on", turnId: pane.turnId } })).body).toEqual({ ok: true });
    const replies = (list: any[]) => list.filter((e: any) => e.type === "item" && e.item.kind === "reply" && e.item.text.startsWith(LONG_ANSWER_START)).map((e: any) => e.item);
    const growing = await waitFor("a partial reply", async () => {
      const r = await events(pane.id, before.next, before.epoch);
      const partial = replies(r.events).filter((i: any) => i.partial === true);
      return partial.length >= 2 && partial.at(-1);
    });
    const working = await paneOf(pane.id);
    expect((await call("POST", `/pane/${pane.id}/abort`, { body: { requestId: "stream-stop-1", turnId: working.turnId } })).body).toEqual({ ok: true });
    await waitFor("idle", async () => (await paneOf(pane.id)).state === "idle");
    const after = replies((await events(pane.id, before.next, before.epoch)).events);
    expect(new Set(after.map((i: any) => i.id)).size).toBe(1);
    expect(after[0].id).toBe(growing.id);
    expect(after.at(-1)).not.toHaveProperty("partial"); // the cursor goes away
    expect(after.at(-1).text.length).toBeGreaterThanOrEqual(growing.text.length);
    const user = (await events(pane.id, 0, "none")).events.find((e: any) => e.type === "item" && e.item.kind === "user" && e.item.text === "Go on");
    expect(user.item.requestId).toBe("stream-1");
  });

  test("a starter opens a new ticket; the same request id replays the same pane and opens nothing", async () => {
    const count = (await snapshot()).panes.length;
    const r = await call("POST", "/starter/sign-in", { body: { requestId: "start-1" } });
    expect(r.status).toBe(200);
    expect((await call("POST", "/starter/sign-in", { body: { requestId: "start-1" } })).body).toEqual({ paneId: r.body.paneId, replayed: true });
    const s = await snapshot();
    expect(s.panes.length).toBe(count + 1);
    expect(s.panes.some((p: { id: string }) => p.id === r.body.paneId)).toBe(true);
    await waitFor("the new ticket's ask", async () => (await paneOf(r.body.paneId)).openAsks.length > 0);
  });
});

describe("a rename", () => {
  const titleOf = async (kind: "workspaces" | "tabs", id: string) => (await snapshot())[kind].find((x: { id: string }) => x.id === id)?.title;

  test("a tab takes a new title, the snapshot shows it and rev rises, and the same request id replays", async () => {
    const before = await snapshot();
    const r = await call("POST", "/rename", { body: { requestId: "rename-1", kind: "tab", id: "triage:inbox", title: "  Open tickets  " } });
    expect([r.status, r.body]).toEqual([200, { ok: true }]);
    const after = await snapshot();
    expect(after.tabs.find((t: { id: string }) => t.id === "triage:inbox").title).toBe("Open tickets");
    expect(after.rev).toBeGreaterThan(before.rev);
    const again = await call("POST", "/rename", { body: { requestId: "rename-1", kind: "tab", id: "triage:inbox", title: "  Open tickets  " } });
    expect([again.status, again.body]).toEqual([200, { ok: true, replayed: true }]);
    expect((await snapshot()).rev).toBe(after.rev);
  });

  test("a workspace takes one too; an unknown target is 404 no-such-target, a bad title 400, and the token still guards the route", async () => {
    expect((await call("POST", "/rename", { body: { requestId: "rename-2", kind: "workspace", id: "triage", title: "Help desk" } })).status).toBe(200);
    expect(await titleOf("workspaces", "triage")).toBe("Help desk");
    const missing = await call("POST", "/rename", { body: { requestId: "rename-3", kind: "tab", id: "triage:nope", title: "X" } });
    expect([missing.status, missing.body.code]).toEqual([404, "no-such-target"]);
    const bad = await call("POST", "/rename", { body: { requestId: "rename-4", kind: "tab", id: "triage:inbox", title: "" } });
    expect([bad.status, bad.body.code]).toEqual([400, "bad-body"]);
    expect((await call("POST", "/rename", { token: "wrong", body: { requestId: "rename-5", kind: "tab", id: "triage:inbox", title: "X" } })).status).toBe(401);
  });

  test.skipIf(!SQLITE)("the names survive a wake of the object, and the receipt still replays", async () => {
    await abortAllDurableObjects();
    expect(await titleOf("tabs", "triage:inbox")).toBe("Open tickets");
    expect(await titleOf("workspaces", "triage")).toBe("Help desk");
    expect(await titleOf("tabs", "triage:helpers")).toBe("Look-ups"); // never renamed: the name in the code
    const again = await call("POST", "/rename", { body: { requestId: "rename-1", kind: "tab", id: "triage:inbox", title: "  Open tickets  " } });
    expect(again.body).toEqual({ ok: true, replayed: true });
  });
});

let closedPane = "";
describe("a close", () => {
  test("the phone closes a ticket: it leaves the snapshot, rev rises, a tab is refused, and the same request id replays", async () => {
    const started = await call("POST", "/starter/sign-in", { body: { requestId: "close-start-1" } });
    expect(started.status).toBe(200);
    const paneId: string = started.body.paneId;
    await waitFor("the new ticket's ask", async () => (await paneOf(paneId))?.openAsks.length > 0);
    const before = await snapshot();
    const refused = await call("POST", "/close", { body: { requestId: "close-1", kind: "tab", id: "triage:inbox" } });
    expect([refused.status, refused.body.code]).toEqual([422, "close-refused"]);
    const r = await call("POST", "/close", { body: { requestId: "close-2", kind: "pane", id: paneId } });
    expect([r.status, r.body]).toEqual([200, { ok: true }]);
    const after = await snapshot();
    expect(after.panes.some((p: { id: string }) => p.id === paneId)).toBe(false);
    expect(after.rev).toBeGreaterThan(before.rev);
    const again = await call("POST", "/close", { body: { requestId: "close-2", kind: "pane", id: paneId } });
    expect([again.status, again.body]).toEqual([200, { ok: true, replayed: true }]);
    const gone = await call("POST", "/close", { body: { requestId: "close-3", kind: "pane", id: paneId } });
    expect([gone.status, gone.body.code]).toEqual([404, "no-such-target"]);
    expect((await call("POST", "/close", { token: "wrong", body: { requestId: "close-4", kind: "pane", id: paneId } })).status).toBe(401);
    closedPane = paneId;
  });

  test.skipIf(!SQLITE)("a closed ticket stays closed after a wake of the object", async () => {
    await abortAllDurableObjects();
    expect((await snapshot()).panes.some((p: { id: string }) => p.id === closedPane)).toBe(false);
  });

  test("history: the closed ticket is listed closed, its items are served from Pi's store, and reopen brings it back", async () => {
    const list = await call("GET", "/conversations");
    expect(list.status).toBe(200);
    const row = list.body.items.find((x: { id: string }) => x.id === closedPane);
    expect(row).toMatchObject({ state: "closed", workspaceId: "triage", tabId: "triage:inbox" });
    expect(row.title).toBe("Priya Shah"); // the third ticket takes the third customer
    const items = await call("GET", `/conversation/${encodeURIComponent(closedPane)}/items`);
    expect(items.status).toBe(200);
    expect(items.body.more).toBe(false);
    expect(items.body.items.length).toBe(row.items);
    expect(items.body.items.some((item: { kind: string }) => item.kind === "user")).toBe(true);
    expect((await call("GET", "/conversation/conv-99999/items")).body.code).toBe("no-such-conversation");
    expect((await call("GET", "/conversations", { token: "wrong" })).status).toBe(401);

    const r = await call("POST", "/reopen", { body: { requestId: "reopen-1", id: closedPane } });
    expect([r.status, r.body]).toEqual([200, { ok: true }]);
    expect((await paneOf(closedPane))?.tabId).toBe("triage:inbox");
    expect((await call("POST", "/reopen", { body: { requestId: "reopen-1", id: closedPane } })).body).toEqual({ ok: true, replayed: true });
    expect((await call("POST", "/reopen", { body: { requestId: "reopen-2", id: "conv-99999" } })).body.code).toBe("no-such-target");
    expect((await call("GET", "/conversations")).body.items.find((x: { id: string }) => x.id === closedPane).state).toBe("open");
  });

  test.skipIf(!SQLITE)("reopen: a reopened ticket stays open after a wake of the object", async () => {
    await abortAllDurableObjects();
    expect((await snapshot()).panes.some((p: { id: string }) => p.id === closedPane)).toBe(true);
  });
});

describe("an action", () => {
  test("a ticket lists Escalate, a tap runs it once and dims the button, and the token still guards the route", async () => {
    const started = await call("POST", "/starter/sign-in", { body: { requestId: "action-start-1" } });
    const paneId: string = started.body.paneId;
    await waitFor("the new ticket's ask", async () => (await paneOf(paneId))?.openAsks.length > 0);
    expect((await paneOf(paneId)).actions).toEqual([{ id: "escalate", label: "Escalate", icon: "flag" }]);
    const path = `/pane/${encodeURIComponent(paneId)}/action`;
    const r = await call("POST", path, { body: { requestId: "action-1", actionId: "escalate" } });
    expect([r.status, r.body]).toEqual([200, { ok: true }]);
    const again = await call("POST", path, { body: { requestId: "action-1", actionId: "escalate" } });
    expect([again.status, again.body]).toEqual([200, { ok: true, replayed: true }]);
    expect((await paneOf(paneId)).actions).toEqual([{ id: "escalate", label: "Escalate", icon: "flag", disabled: true }]);
    const gone = await call("POST", path, { body: { requestId: "action-2", actionId: "nope" } });
    expect([gone.status, gone.body.code]).toEqual([404, "no-such-action"]);
    expect((await call("POST", path, { token: "wrong", body: { requestId: "action-3", actionId: "escalate" } })).status).toBe(401);
  });
});

describe("the trust model", () => {
  test("a binding is readable as process.env, so every tool in the Worker can read the token (README)", () => {
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
    expect((await call("POST", "/starter/sign-in", { body: { requestId: "start-1" } })).body.replayed).toBe(true);
    if (!SQLITE) return; // in memory, Pi's conversations are gone, and so are the panes
    const panes = (await snapshot()).panes;
    expect(panes.some((p: { id: string }) => p.id === ticket.id)).toBe(true); // a pane id is the conversation id
    const r = await events(ticket.id, cursor, before);
    expect(r.reset).toBe(true);
    expect(r.epoch).toBe(after.epoch);
    expect(r.events[0]).toEqual({ type: "reset" });
    expect(r.events.some((e: any) => e.type === "item" && e.item.kind === "reply" && e.item.text.startsWith(SIGN_IN_DONE))).toBe(true);
    expect((await notes()).length).toBe(1); // the note was not written again
  });

  test.skipIf(!SQLITE)("a wake keeps the ask: raised again before ready, with the same id, and a tap sent across it is taken once", async () => {
    const r = await call("POST", "/starter/sign-in", { body: { requestId: "start-2" } });
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

  test.skipIf(!SQLITE)("the M50 spec 14 case: a tap that is the first request after a wake is taken, not too-late", async () => {
    const paneId = (await call("POST", "/starter/sign-in", { body: { requestId: "start-3" } })).body.paneId;
    const old = await waitFor("an ask", async () => (await paneOf(paneId)).openAsks[0]);
    await abortAllDurableObjects();
    // No read between the wake and the tap: the answer itself starts the object, which raises the ask before ready.
    const tap = { requestId: "answer-first-after-wake", askId: old.id, revision: old.revision, answer: { optionId: "allow" } };
    expect((await call("POST", `/pane/${paneId}/answer`, { body: tap })).body).toEqual({ result: "taken" });
    expect((await call("POST", `/pane/${paneId}/answer`, { body: tap })).body).toEqual({ result: "taken", replayed: true });
    await waitFor("the ticket to finish", async () => (await paneOf(paneId)).state === "idle");
  });

  test.skipIf(!SQLITE)("an evicted busy session goes on by alarm, with no read: PiHarness's wake job restarts the object", async () => {
    const stub = env.MEMBER.getByName("main");
    const pane = (await snapshot()).panes.find((p: any) => p.tabId === "triage:inbox" && p.state === "idle");
    expect((await call("POST", `/pane/${pane.id}/send`, { body: { requestId: "send-busy", text: "Any update?", turnId: pane.turnId } })).body).toEqual({ ok: true });
    await waitFor("the slow answer to start", async () => (await paneOf(pane.id)).state === "working");
    await abortAllDurableObjects(); // the object dies mid-run, as on an eviction or a deploy
    // The new instance has served nothing and has not started: no request reached it.
    const before = await runInDurableObject(stub, async (o: Member, state) => ({ started: o.lifecycle.isStarted(), reads: o.reads, alarm: await state.storage.getAlarm() }));
    expect(before).toMatchObject({ started: false, reads: 0 });
    expect(before.alarm).not.toBeNull(); // the wake job's heartbeat, due within 30 s
    // Fire that alarm now instead of waiting for it. Still no read.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const session = String(pane.id).replace(/^conv-/, "");
    const after = await waitFor("the run to end with no read", () =>
      runInDurableObject(stub, async (o: Member) => !(await o.harness.session(session).busy()) && { reads: o.reads, entries: await o.harness.session(session).messages() }),
    );
    expect(after.reads).toBe(0);
    const replies = after.entries.flatMap((e) => (e.model ?? []).filter((m: any) => m.role === "assistant")).map((m: any) => JSON.stringify(m.content));
    expect(replies.at(-1)).toContain(LONG_ANSWER_START);
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

describe("more kinds of ask", () => {
  test("a ticket with questions asks a choice, then a text ask, and each takes its own answer shape", async () => {
    const r = await call("POST", "/starter/double-charge", { body: { requestId: "start-ask" } });
    const id = r.body.paneId;
    const answer = (askId: string, revision: number, requestId: string, payload: object) =>
      call("POST", `/pane/${id}/answer`, { body: { requestId, askId, revision, answer: payload } });
    const note = await waitFor("the note's ask", async () => (await paneOf(id)).openAsks.find((a: { kind: string }) => a.kind === "permission"));
    await answer(note.id, note.revision, "ask-note", { optionId: "allow" });
    const choice = await waitFor("the choice", async () => (await paneOf(id)).openAsks.find((a: { kind: string }) => a.kind === "choice"));
    expect(choice.options.map((o: { id: string }) => o.id)).toEqual(["billing", "accounts", "other"]);
    expect((await answer(choice.id, choice.revision, "ask-bad", { text: "billing" })).status).toBe(400);
    expect((await answer(choice.id, choice.revision, "ask-choice", { optionIds: ["other"] })).body).toEqual({ result: "taken" });
    const text = await waitFor("the text ask", async () => (await paneOf(id)).openAsks.find((a: { kind: string }) => a.kind === "text"));
    expect((await answer(text.id, text.revision, "ask-long", { text: "x".repeat(281) })).body.code).toBe("bad-body");
    expect((await answer(text.id, text.revision, "ask-text", { text: "On it." })).body).toEqual({ result: "taken" });
    await waitFor("idle", async () => (await paneOf(id)).state === "idle");
  });
});

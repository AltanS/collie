import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BeaconMatcher } from "../beacon/decorate.ts";
import type { AuditEntry } from "../audit.ts";
import { HOST } from "../host.ts";
import { HILL_CLEAR_UNSAVED_TEXT, HILL_LOCAL_TEXT, HILL_OFF_TEXT, HILL_RID_REUSED, HILL_UNSAVED_TEXT, hillAnswerRoute, hillClearRoute, hillListRoute, pairedDeviceId, withHillRev } from "../server.ts";
import type { SnapshotResponse } from "../types.ts";
import type { WalkyHost, WalkyPane } from "../walky/deliver.ts";
import { WalkyLog } from "../walky/log.ts";
import { WalkyService } from "../walky/service.ts";
import { walkySocketPath, WalkyServer, type PlaceTarget } from "../walky/socket.ts";
import { parseJsonObject, type JsonObject } from "../../web/src/lib/json.ts";
import { memoryHillReceipts, type HillReceiptSurface } from "./receipts.ts";
import { hillDeviceId, HillService, type HillServiceDeps } from "./service.ts";
import { HillStore } from "./store.ts";
import { walkyPlace, walkySend } from "./walky.ts";

import { spaceOf } from "../walky/space.ts";

/** One unnamed space on one machine: every fixture pane shares it, and no rule reads it yet. */
const SOLO_SPACE = spaceOf({ memberId: "local", spaceId: "w1", spaceLabel: "w1" });

const roots: string[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const RID = "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f";
const OTHER_RID = "11111111-1111-4111-8111-111111111111";

const panes: WalkyPane[] = [
  { session: "main", paneId: "%1", agent: true, harness: "agent-x", label: "repo#one", state: "idle", activeAt: null, instance: "aaaa", terminal: true, off: false, space: SOLO_SPACE },
  { session: "main", paneId: "%2", agent: true, harness: "agent-y", label: "repo#two", state: "idle", activeAt: null, instance: "bbbb", terminal: true, off: false, space: SOLO_SPACE },
];

interface Rig {
  readonly walky: WalkyService;
  readonly hill: HillService;
  readonly typed: { readonly paneId: string; readonly text: string }[];
  readonly stateDir: string;
}

/** A bridge's walky and hill as `bridge/index.ts` wires them, over a fake multiplexer that records what it types. */
function rig(over: Partial<HillServiceDeps> = {}): Rig {
  const stateDir = mkdtempSync(join(tmpdir(), "hill-routes-"));
  roots.push(stateDir);
  const typed: { paneId: string; text: string }[] = [];
  const host: WalkyHost = {
    panes: () => panes,
    send: async (pane, _id, text) => {
      typed.push({ paneId: pane.paneId, text });
      return { outcome: "sent" };
    },
    sendState: () => ({ outcome: "sent" }),
    cancelHeld: () => undefined,
  };
  let w = 0;
  const walky = new WalkyService({
    log: new WalkyLog(join(stateDir, "walky")),
    host,
    memberId: null,
    enabled: () => true,
    machine: "desk",
    keyPem: () => null,
  });
  let n = 0;
  const hill = new HillService({
    store: new HillStore(null, () => 1000),
    receipts: memoryHillReceipts(),
    place: walkyPlace(walky, null),
    send: walkySend(walky, {
      sleep: async () => undefined,
      mintId: () => {
        w += 1;
        return `wt_e2e${String(w).padStart(7, "0")}`;
      },
    }),
    crewMode: () => "solo",
    walkyOn: () => true,
    memberId: "m_aaaaaaaaaa",
    machine: "desk",
    now: () => 1000,
    mintId: () => {
      n += 1;
      return `dc_e2e${String(n).padStart(9, "0")}`;
    },
    ...over,
  });
  return { walky, hill, typed, stateDir };
}

const post = {
  requestId: RID,
  title: "Ship the zoom fix in 1.28.1?",
  summary: "The pill moves out of Chat. The leg is green.",
  options: [
    { intent: "yes", label: "Yes, Edge first" },
    { intent: "no", label: "No, wait for 1.29.0" },
  ],
  recommends: { intent: "yes", why: "Edge users find it in a day." },
};

async function posted(r: Rig, fields: JsonObject = post): Promise<string> {
  const from = r.hill.agentSender(panes[0]!, "local/%1#aaaa");
  const answer = await r.hill.postFields(from, fields);
  if (!answer.ok) throw new Error(answer.error);
  return answer.decision.id;
}

const answerBody = (id: string, intent: string, text: string | null, rid = RID) => ({ rid, node: `hill/${id}`, intent, value: { text } });

describe("GET /api/hill", () => {
  test("lists open and closed decisions with the revision; `since` equal to the revision answers unchanged", async () => {
    const r = rig();
    const empty = await hillListRoute(r.hill, null, null).json();
    expect(empty).toEqual({ rev: 0, open: [], closed: [], closedTotal: 0 });
    const id = await posted(r);
    const list = await hillListRoute(r.hill, null, null).json();
    expect(list).toMatchObject({ open: [{ id, state: "open", title: post.title }], closed: [] });
    const rev = r.hill.rev();
    expect(rev).toBeNumber();
    expect(await hillListRoute(r.hill, String(rev), null).json()).toEqual({ rev, unchanged: true });
    expect(await hillListRoute(r.hill, String(rev! - 1), null).json()).toMatchObject({ open: [{ id }] });
  });

  test("a bridge built without the hill answers 404", async () => {
    const res = hillListRoute(undefined, null, null);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(HILL_OFF_TEXT);
  });
});

describe("POST /api/hill/clear", () => {
  const ctx = { device: "Pixel 9", acceptEncoding: null };

  /** One open and one answered decision. */
  async function twoDecisions(r: Rig): Promise<{ open: string; answered: string }> {
    const answered = await posted(r);
    await hillAnswerRoute(r.hill, answerBody(answered, "yes", null), ctx);
    const open = await posted(r, { ...post, requestId: OTHER_RID });
    return { open, answered };
  }

  test("an empty body clears every closed decision, keeps the open one, and moves the revision", async () => {
    const r = rig();
    const { open, answered } = await twoDecisions(r);
    const rev = r.hill.rev();
    const res = hillClearRoute(r.hill, {}, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: 1, skipped: [] });
    const list = await hillListRoute(r.hill, null, null).json();
    expect(list).toMatchObject({ open: [{ id: open }], closed: [], closedTotal: 0 });
    expect(r.hill.decision(answered)).toBeUndefined();
    expect(r.hill.rev()).toBeGreaterThan(rev!);
    // The phone that held the old revision reads the new list, not `unchanged`.
    expect(await hillListRoute(r.hill, String(rev), null).json()).toMatchObject({ closed: [] });
  });

  test("ids: the named closed ones go; an open one and an unknown one come back skipped", async () => {
    const r = rig();
    const { open, answered } = await twoDecisions(r);
    const res = hillClearRoute(r.hill, { ids: [answered, open, "dc_unknown00001"] }, ctx);
    expect(await res.json()).toEqual({
      cleared: 1,
      skipped: [
        { id: open, reason: "open" },
        { id: "dc_unknown00001", reason: "missing" },
      ],
    });
    expect(r.hill.decision(open)?.state).toBe("open");
  });

  test("a body of another shape is a 400 and clears nothing", async () => {
    const r = rig();
    const { answered } = await twoDecisions(r);
    for (const body of [undefined, null, [], "all", { ids: "dc_aaaaaaaaaaa1" }, { ids: [1] }, { ids: ["not an id"] }, { all: true }, { ids: [], extra: 1 }, { ids: Array.from({ length: 201 }, () => answered) }]) {
      expect(hillClearRoute(r.hill, body, ctx).status).toBe(400);
    }
    expect(r.hill.decision(answered)?.state).toBe("answered");
  });

  test("a bridge built without the hill answers 404; a write that fails is a 503 and clears nothing", async () => {
    expect(hillClearRoute(undefined, {}, ctx).status).toBe(404);
    const r = rig();
    const { answered } = await twoDecisions(r);
    const res = hillClearRoute({ clear: () => null }, {}, ctx);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe(HILL_CLEAR_UNSAVED_TEXT);
    expect(r.hill.decision(answered)?.state).toBe("answered");
  });

  test("it works with the Hill off: it types nothing and posts nothing, and the route still clears", async () => {
    let on = true;
    const r = rig({ hillSwitch: { on: () => on } });
    const { answered } = await twoDecisions(r);
    on = false;
    expect(await hillClearRoute(r.hill, {}, ctx).json()).toEqual({ cleared: 1, skipped: [] });
    expect(r.hill.decision(answered)).toBeUndefined();
  });

  test("it writes one audit line with the device label and counts, never a title", async () => {
    const audit: AuditEntry[] = [];
    const r = rig({ audit: (entry) => audit.push(entry) });
    await twoDecisions(r);
    audit.length = 0;
    hillClearRoute(r.hill, {}, ctx);
    expect(audit).toEqual([{ action: "hill.clear", device: "Pixel 9", detail: { count: 1, all: true, skipped: 0 } }]);
  });
});

describe("POST /api/hill/answer", () => {
  test("a body of another shape is a 400, and writes no receipt", async () => {
    const r = rig();
    const id = await posted(r);
    for (const body of [undefined, null, [], { rid: "x", node: `hill/${id}`, intent: "yes", value: { text: null } }, { rid: RID, node: id, intent: "yes", value: { text: null } }, { rid: RID, node: `hill/${id}`, intent: "yes", value: "go" }]) {
      expect((await hillAnswerRoute(r.hill, body, { device: "Pixel 9", acceptEncoding: null })).status).toBe(400);
    }
    // The same rid still answers fresh: nothing was recorded under it.
    expect(await (await hillAnswerRoute(r.hill, answerBody(id, "yes", null), { device: "Pixel 9", acceptEncoding: null })).json()).toMatchObject({ rid: RID, code: "ok" });
  });

  test("the device's record id rides beside its label on the ok receipt and the stored answer", async () => {
    const r = rig();
    const id = await posted(r);
    const deviceId = hillDeviceId("b".repeat(64));
    const res = await hillAnswerRoute(r.hill, answerBody(id, "yes", null), { device: "Pixel 9", deviceId, acceptEncoding: null });
    expect(await res.json()).toMatchObject({ rid: RID, code: "ok", deviceId });
    expect(r.hill.decision(id)?.answer).toMatchObject({ by: "Pixel 9", deviceId });
  });

  test("pairedDeviceId: the paired record's id, never for the local credential, an unknown token or a broken registry", () => {
    const req = (authorization?: string): Request => new Request("http://h/api/hill/answer", { headers: authorization === undefined ? {} : { authorization } });
    const gate = {
      resolve: (token: string | null) => (token === "tok-phone" ? { label: "Pixel 9", tokenHash: "c".repeat(64) } : token === "tok-old" ? { label: "Old" } : null),
      local: (token: string | null) => token === "tok-local",
    };
    expect(pairedDeviceId(req("Bearer tok-phone"), gate)).toBe(hillDeviceId("c".repeat(64)));
    expect(pairedDeviceId(req("Bearer tok-phone"), gate)).toMatch(/^dv_[0-9a-f]{16}$/u);
    expect(pairedDeviceId(req("Bearer tok-old"), gate)).toBeNull();
    expect(pairedDeviceId(req("Bearer tok-local"), gate)).toBeNull();
    expect(pairedDeviceId(req("Bearer tok-unknown"), gate)).toBeNull();
    expect(pairedDeviceId(req("Bearer tok-phone"))).toBeNull();
    const broken = {
      resolve: (): { label: string } | null => {
        throw new Error("unreadable");
      },
    };
    expect(pairedDeviceId(req("Bearer tok-phone"), broken)).toBeNull();
    // One record, one id; another record, another id. The id holds no part of the hash it came from.
    expect(hillDeviceId("c".repeat(64))).not.toBe(hillDeviceId("d".repeat(64)));
    expect(hillDeviceId("c".repeat(64))).not.toContain("cccc");
  });

  test("every receipt is a 200: ok, rejected and gone; the same rid and choice replays the stored receipt", async () => {
    const r = rig();
    const id = await posted(r);
    const ctx = { device: "Pixel 9", acceptEncoding: null };
    const rejected = await hillAnswerRoute(r.hill, answerBody(id, "maybe", null, OTHER_RID), ctx);
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toMatchObject({ rid: OTHER_RID, code: "rejected", state: "open" });
    const ok = await hillAnswerRoute(r.hill, answerBody(id, "yes", null), ctx);
    const receipt = await ok.json();
    expect(receipt).toMatchObject({ rid: RID, code: "ok", state: "answered", delivery: "typed" });
    expect(await (await hillAnswerRoute(r.hill, answerBody(id, "yes", null), ctx)).json()).toEqual(receipt);
    expect(r.typed).toHaveLength(1);
    const gone = await hillAnswerRoute(r.hill, answerBody(id, "no", null, "22222222-2222-4222-8222-222222222222"), ctx);
    expect(gone.status).toBe(200);
    expect(await gone.json()).toMatchObject({ code: "gone", state: "answered" });
  });

  test("a rid used again with another choice is a 409 and types nothing more", async () => {
    const r = rig();
    const id = await posted(r);
    const ctx = { device: "Pixel 9", acceptEncoding: null };
    await hillAnswerRoute(r.hill, answerBody(id, "yes", null), ctx);
    const reused = await hillAnswerRoute(r.hill, answerBody(id, "no", null), ctx);
    expect(reused.status).toBe(409);
    expect(await reused.text()).toBe(HILL_RID_REUSED);
    expect(r.typed).toHaveLength(1);
  });

  test("a first receipt that cannot be written is a 503: nothing closes, nothing is typed", async () => {
    const failing: HillReceiptSurface = { ...memoryHillReceipts(), recordFirst: async () => false };
    const r = rig({ receipts: failing });
    const id = await posted(r);
    const res = await hillAnswerRoute(r.hill, answerBody(id, "yes", null), { device: "Pixel 9", acceptEncoding: null });
    expect(res.status).toBe(503);
    expect(await res.text()).toBe(HILL_UNSAVED_TEXT);
    expect(r.hill.list().open.map((d) => d.id)).toEqual([id]);
    expect(r.typed).toEqual([]);
  });

  test("the answer carries the paired device's label; with none, `phone`", async () => {
    const r = rig();
    const one = await posted(r);
    const two = await posted(r, { ...post, requestId: OTHER_RID, title: "Second?" });
    await hillAnswerRoute(r.hill, answerBody(one, "yes", null), { device: "Pixel 9", acceptEncoding: null });
    await hillAnswerRoute(r.hill, answerBody(two, "no", null, "33333333-3333-4333-8333-333333333333"), { device: null, acceptEncoding: null });
    expect(r.typed.map((t) => t.text.split("\n")[0]!.replace(/wt_\w+/, "wt_"))).toEqual(["[walky-talky wt_] from operator (Pixel 9)", "[walky-talky wt_] from operator (phone)"]);
    expect(r.hill.list().closed.map((d) => `${d.id} ${d.answer?.by}`).toSorted()).toEqual([`${one} Pixel 9`, `${two} phone`]);
  });

  test("a bridge built without the hill answers 404", async () => {
    expect((await hillAnswerRoute(undefined, answerBody("dc_aaaaaaaaaaa1", "yes", null), { device: null, acceptEncoding: null })).status).toBe(404);
  });
});

describe("the routes' gates, pinned by source", () => {
  const src = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
  const routeBody = (head: string) => {
    const at = src.indexOf(head);
    expect(at).toBeGreaterThan(-1);
    // One dispatch per route: no second copy in the crew path.
    expect(src.indexOf(head, at + head.length)).toBe(-1);
    return src.slice(at, src.indexOf("if (pathname ===", at + head.length));
  };

  test("the list sits behind the read gate, before `?host=` is looked at", () => {
    const body = routeBody('if (pathname === "/api/hill" && req.method === "GET") {');
    expect(body.indexOf('browserGate("read")')).toBeGreaterThan(-1);
    expect(body.indexOf('browserGate("read")')).toBeLessThan(body.indexOf('host.kind === "member"'));
    expect(body).toContain("text(HILL_LOCAL_TEXT, 400)");
  });

  test("the answer sits behind the write gate, as `POST /api/walky` does, before the body is read; the label is the paired device's", () => {
    const body = routeBody('if (pathname === "/api/hill/answer" && req.method === "POST") {');
    expect(body.indexOf('browserGate("write")')).toBeGreaterThan(-1);
    expect(body.indexOf('browserGate("write")')).toBeLessThan(body.indexOf("req.json()"));
    expect(body.indexOf('host.kind === "member"')).toBeLessThan(body.indexOf("req.json()"));
    expect(body).toContain("whois(req).device");
    const walky = routeBody('if (pathname === "/api/walky" && req.method === "POST") {');
    expect(walky).toContain('browserGate("write")');
    expect(HILL_LOCAL_TEXT).toContain("this machine");
  });
});

describe("the snapshot's hillRev", () => {
  const snapshot: SnapshotResponse = { bridge: "connected", agents: [], shellPanes: [], workspaces: [], tabs: [], sessions: [], ts: 5 };

  test("absent without the hill: the same body, byte for byte", () => {
    expect(JSON.stringify(withHillRev(snapshot, undefined))).toBe(JSON.stringify(snapshot));
  });

  test("present with the hill, from the hill's own revision", () => {
    expect(withHillRev(snapshot, 1234)).toEqual({ ...snapshot, hillRev: 1234 });
  });
});

// ── End to end (M96) ──────────────────────────────────────────────────────────────────────────────
// An agent posts over the real socket, the phone reads `GET /api/hill` and answers, and the bridge
// types the contract's body into the reply target as one operator walky message.
const matcher: BeaconMatcher = {
  namespace: "tmux",
  scope: async () => "/tmp/tmux-1/default",
  matches: (pane, marker, scope) => marker.scope === scope && pane.paneId === marker.pane,
  notesWithoutHooks: { agentDetection: "", agentSessionRef: "" },
};
const target: PlaceTarget = { session: "main", matcher, paneIds: () => ["%1", "%2"] };

function overSocket(path: string, line: JsonObject): Promise<JsonObject | null> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let got = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      got += chunk;
    });
    socket.on("end", () => resolve(parseJsonObject(got.trim()) ?? null));
    socket.on("error", reject);
    socket.write(`${JSON.stringify(line)}\n`);
  });
}

describe("end to end", () => {
  test.skipIf(HOST.platform === "win32")("hill.clear over the socket needs no pane, clears every closed decision and answers the count", async () => {
    const r = rig();
    const server = new WalkyServer({ socketPath: walkySocketPath(r.stateDir), service: r.walky, targets: () => [target], log: () => undefined, hill: r.hill });
    expect(await server.start()).toBe(true);
    stops.push(() => server.stop());
    const answered = await posted(r);
    await hillAnswerRoute(r.hill, answerBody(answered, "yes", null), { device: "Pixel 9", acceptEncoding: null });
    const open = await posted(r, { ...post, requestId: OTHER_RID });
    const path = walkySocketPath(r.stateDir);
    // Markers that name no pane here do not stop it either: the verb is the person's.
    const stranger = [{ namespace: "tmux", scope: "/tmp/tmux-1/default", pane: "%9" }];
    expect(await overSocket(path, { v: 1, op: "hill.clear", markers: stranger })).toEqual({ ok: true, cleared: 1 });
    expect(await overSocket(path, { v: 1, op: "hill.clear", markers: [] })).toEqual({ ok: true, cleared: 0 });
    expect(r.hill.decision(answered)).toBeUndefined();
    expect(r.hill.decision(open)?.state).toBe("open");
  });

  test.skipIf(HOST.platform === "win32")("post over the socket, read the hill, answer, and the walky send types the contract's body", async () => {
    const r = rig();
    const server = new WalkyServer({ socketPath: walkySocketPath(r.stateDir), service: r.walky, targets: () => [target], log: () => undefined, hill: r.hill });
    expect(await server.start()).toBe(true);
    stops.push(() => server.stop());

    const markers = [{ namespace: "tmux", scope: "/tmp/tmux-1/default", pane: "%1" }];
    const answer = await overSocket(walkySocketPath(r.stateDir), { v: 1, op: "hill.post", markers, ...post, replyTo: "local/%2", text: "optional" });
    expect(answer).toMatchObject({ ok: true, decision: { id: "dc_e2e000000001", from: { kind: "agent", address: "local/%1#aaaa" }, replyTo: "local/%2#bbbb" } });

    const list = await hillListRoute(r.hill, null, null).json();
    expect(list).toMatchObject({ open: [{ id: "dc_e2e000000001", recommends: { intent: "yes" } }] });

    const res = await hillAnswerRoute(r.hill, answerBody("dc_e2e000000001", "yes", "Not before the browser leg is green."), { device: "Pixel 9", acceptEncoding: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rid: RID, code: "ok", reason: null, state: "answered", delivery: "typed", trick: "none", at: 1000 });

    expect(r.typed).toEqual([
      {
        paneId: "%2",
        // The answer goes to another session than the poster's: no title, no label (the poster's words).
        text: "[walky-talky wt_e2e0000001] from operator (Pixel 9)\nAnswer to dc_e2e000000001\nOption: yes\nNot before the browser leg is green.\nRead the decision with: collie hill status dc_e2e000000001",
      },
    ]);
    expect(r.walky.status("wt_e2e0000001").message).toMatchObject({ kind: "operator", from: { label: "Pixel 9", address: null } });
    const after = await overSocket(walkySocketPath(r.stateDir), { v: 1, op: "hill.status", markers, id: "dc_e2e000000001" });
    expect(after).toMatchObject({ ok: true, decision: { state: "answered", answer: { intent: "yes", by: "Pixel 9", delivery: "typed" } } });
  });
});

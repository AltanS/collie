// The protocol tests of the wire, written once and run twice: over the private socket (protocol.test.ts) and
// straight against the core's `handle(Request)` (core.test.ts), with no socket and no server. The two runs must
// agree, so the core is the wire and the socket is only its transport.
import { afterAll, beforeAll, describe, expect, test as bunTest } from "bun:test";
import { api, call, type Dial } from "./client.ts";
import {
  ALL_CAPS,
  type AskInput,
  type Caps,
  type ConversationRow,
  type CoreOptions,
  type HistoryProvider,
  idOk,
  type Item,
  type PaneAction,
  type PaneHandle,
  type PermissionAskInput,
  type Starter,
  type WorkspaceHandle,
} from "../../../packages/durable-sdk/src/core/index.ts";
import { cleanup, waitFor } from "./util.ts";

/** A program with no layout yet, and the dial that reaches it. */
export interface Opened {
  readonly epoch: string;
  workspace(id: string, o: { title: string; cwd?: string }): WorkspaceHandle;
  starters(list: Starter[]): void;
  history(provider: HistoryProvider): void;
  ready(): void;
  close(): Promise<void>;
}
export interface Transport {
  name: string;
  /**
   * Tests this transport cannot pass by design, by title, each with the reason. They show as skipped with the reason
   * in the title. Left out: every test runs. A title that names no test fails the suite.
   */
  skip?: Readonly<Record<string, string>>;
  open(o: { hostName: string; caps?: Caps; hooks?: CoreOptions["hooks"]; onRename?: CoreOptions["onRename"] }): Promise<{ collie: Opened; dial: Dial }>;
}

export function protocolSuite(transport: Transport) {
  const titles = new Set<string>();
  const test = (title: string, fn: Parameters<typeof bunTest>[1]) => {
    titles.add(title);
    const reason = transport.skip?.[title];
    return reason === undefined ? bunTest(title, fn) : bunTest.skip(`${title} [skipped: ${reason}]`, fn);
  };
  describe(transport.name, () => {
    let collie: Opened;
    let d: Dial;
    let pane: PaneHandle;
    const sent: [string, boolean, string][] = [];
    /** What the program's `onRename` hook decides, and the renames it was asked about. */
    let renameVerdict: boolean | Promise<boolean> = true;
    const asked: unknown[] = [];
    /** What the program's `onClose` hook decides (`undefined` accepts, as a hook that returns nothing does), and what it was asked. */
    let closeVerdict: boolean | undefined | Promise<boolean | undefined> = undefined;
    const closeAsked: unknown[] = [];
    /** What the program's `onReopen` hook decides (`undefined` accepts), what it was asked, and what it does first. */
    let reopenVerdict: boolean | undefined = undefined;
    const reopenAsked: unknown[] = [];
    let reopenShows: ((id: string) => void) | undefined;
    let aborted = 0;
    let starts = 0;
    const post = (path: string, body: unknown) => call(d, "POST", path, body);

    const options = [
      { id: "allow", label: "Allow", effect: "allow" as const },
      { id: "deny", label: "Deny", effect: "deny" as const },
    ];
    let n = 0;
    const askInput = (over: Partial<PermissionAskInput> = {}): AskInput => ({
      kind: "permission",
      toolCallId: `call-${++n}`,
      title: "write_note wants to write /tmp/notes.txt",
      itemId: `call-${n}`,
      options,
      ...over,
    });
    /** An ask nobody awaits. A close rejects it, so give it a catch. */
    const hold = (p: PaneHandle, input: AskInput) => {
      const pending = p.ask(input);
      pending.catch(() => {});
      return pending;
    };
    const mk = (id: string) => collie.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane(id, { title: id.toUpperCase(), harness: "x" });
    const paneInfo = async (id: string) => (await api.snapshot(d)).body.panes.find((x) => x.id === id)!;

    beforeAll(async () => {
      ({ collie, dial: d } = await transport.open({
        hostName: "t",
        hooks: {
          onRename: (target, requestId) => {
            asked.push({ ...target, requestId });
            return renameVerdict;
          },
          onClose: (target, requestId) => {
            closeAsked.push({ ...target, requestId });
            return closeVerdict;
          },
          onReopen: (target, requestId) => {
            reopenAsked.push({ ...target, requestId });
            if (reopenVerdict !== false) reopenShows?.(target.id);
            return reopenVerdict;
          },
        },
      }));
      pane = mk("p1");
      pane.onSend((text, o) => void sent.push([text, o.steer, o.requestId]));
      pane.onAbort(() => void aborted++);
      collie.starters([
        {
          id: "s1",
          label: "S",
          run: async () => {
            starts++;
            return { paneId: "p1" };
          },
        },
      ]);
      collie.ready();
    });
    afterAll(async () => {
      await collie.close();
      cleanup();
    });

    describe("version and routes", () => {
      test("hello reports the range, host and caps", async () => {
        const r = await api.hello(d);
        expect(r.body.protocol).toEqual({ min: 1, max: 1 });
        expect(r.body.host.name).toBe("t");
        expect(r.body.ready).toBe(true);
        expect(r.body.epoch).toMatch(/^[0-9a-f]{32}$/); // 128 bits
        expect(r.body.caps).toEqual({ asks: true, starters: true, send: true, steer: true, abort: true, rename: true, close: true, actions: true, history: false, reopen: true, terminal: false });
      });
      test("409 incompatible with the range, never a 5xx; a header that is not an integer is the same", async () => {
        for (const version of [0, 2, 99]) {
          const r = await api.hello({ ...d, version });
          expect(r.status).toBe(409);
          // The refusal names both sides (WIRE.md section 2): the version the caller sent, and this program's range.
          expect(r.body as unknown).toEqual({ code: "incompatible", range: { min: 1, max: 1 }, refusal: { code: "version", collie: [version, version], program: [1, 1] } });
        }
        for (const bad of ["abc", "1.0", "-1", "", "1x", "0x1"]) {
          const r = await call({ ...d, version: undefined }, "GET", "/snapshot", undefined, { "x-collie-session": bad });
          expect([bad, r.status, r.body.code]).toEqual([bad, 409, "incompatible"]);
        }
        expect((await api.snapshot({ ...d, version: 2 })).status).toBe(409);
      });
      test("hello works without a version header, other routes do not", async () => {
        expect((await api.hello({ ...d, version: undefined })).status).toBe(200);
        expect((await api.snapshot({ ...d, version: undefined })).status).toBe(409);
        expect((await call({ ...d, version: undefined }, "POST", "/pane/p1/send", {})).status).toBe(409);
      });
      test("the check order is version, hello, ready, route", async () => {
        const { collie: c, dial: t } = await transport.open({ hostName: "o" });
        // not ready: a bad version is 409 before 503, a good one is 503 before 404
        expect((await call({ ...t, version: 9 }, "GET", "/snapshot")).status).toBe(409);
        expect((await call({ ...t, version: 9 }, "GET", "/nothing")).status).toBe(409);
        expect((await call(t, "GET", "/snapshot")).status).toBe(503);
        expect((await call(t, "GET", "/nothing")).status).toBe(503);
        expect((await call(t, "POST", "/pane/p/send", {})).status).toBe(503);
        expect((await call(t, "POST", "/rename", {})).status).toBe(503);
        expect((await call(t, "POST", "/close", {})).status).toBe(503);
        expect((await api.hello(t)).status).toBe(200); // hello answers before ready is looked at
        c.ready();
        expect((await call(t, "GET", "/nothing")).status).toBe(404);
        await c.close();
      });
      test("404 for an unknown pane, starter and route", async () => {
        expect((await api.events(d, "nope", 0)).status).toBe(404);
        expect((await api.send(d, "nope", "x")).status).toBe(404);
        expect((await api.abort(d, "nope")).status).toBe(404);
        expect((await api.answer(d, "nope", "a", "allow")).status).toBe(404);
        expect((await api.start(d, "nope")).status).toBe(404);
        expect((await call(d, "GET", "/what")).status).toBe(404);
        expect((await call(d, "GET", "/rename")).status).toBe(404); // wrong method
        expect((await call(d, "GET", "/close")).status).toBe(404); // wrong method
        expect((await call(d, "GET", "/pane/p1/answer")).status).toBe(404); // wrong method
        expect((await call(d, "DELETE", "/snapshot")).status).toBe(404);
        expect((await api.events(d, "nope", 0)).body.code).toBe("no-such-pane");
        expect((await api.start(d, "nope")).body.code).toBe("no-such-starter");
        expect((await call(d, "GET", "/what")).body.code).toBe("not-found");
      });
      test("a POST body over 64 KiB is 413 too-large, on every POST route", async () => {
        const pad = "x".repeat(70_000);
        for (const path of ["/pane/p1/answer", "/pane/p1/send", "/pane/p1/abort", "/starter/s1", "/rename", "/close"]) {
          const r = await post(path, { requestId: "big", pad });
          expect([path, r.status, r.body.code]).toEqual([path, 413, "too-large"]);
        }
        const r = await call(d, "POST", "/pane/p1/send", "{ not json");
        expect([r.status, r.body.code]).toEqual([400, "bad-json"]);
      });
    });

    describe("the id rule", () => {
      const bad = ["", "a/b", "a?b", "a#b", "a b", "a\tb", "a\nb", "a\u0000b", "a\u0085b", "a​b", "x".repeat(129), "é".repeat(65)];
      test("idOk: 1 to 128 bytes, no control, no whitespace, none of / ? #", () => {
        for (const id of ["a", "x".repeat(128), "é".repeat(64), "ws:tab", "conv-1", "e12:3", "~-_.:|"]) expect([id.length, idOk(id)]).toEqual([id.length, true]);
        for (const id of bad) expect([id, idOk(id)]).toEqual([id, false]);
      });
      test("a workspace, tab, pane or starter with a bad id is refused when the program makes it", () => {
        for (const id of bad) {
          expect(() => collie.workspace(id, { title: "x" })).toThrow("id rule");
          expect(() => collie.workspace("w", { title: "W" }).tab(id, { title: "x" })).toThrow("id rule");
          expect(() => collie.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane(id, { title: "x", harness: "x" })).toThrow("id rule");
          expect(() => collie.starters([{ id, label: "x", run: async () => ({ paneId: "p1" }) }])).toThrow("id rule");
        }
        collie.starters([{ id: "s1", label: "S", run: async () => ((starts++), { paneId: "p1" }) }]); // put the good one back
      });
      test("the tab id is <workspace>:<tab>, unique across workspaces, and a colon in a part is refused", async () => {
        collie.workspace("w2", { title: "W2" }).tab("t", { title: "T2" });
        const s = (await api.snapshot(d)).body;
        expect(s.tabs.map((t) => t.id)).toEqual(expect.arrayContaining(["w:t", "w2:t"]));
        expect(s.tabs.some((t) => t.id.includes("/"))).toBe(false);
        expect(() => collie.workspace("a:b", { title: "x" })).toThrow();
        expect(() => collie.workspace("w", { title: "W" }).tab("c:d", { title: "x" })).toThrow();
        expect(() => collie.workspace("w", { title: "W" }).tab("x".repeat(127), { title: "x" })).toThrow("id rule"); // "w:xxx..." is 129 bytes
      });
      test("an item id, a remove id and a settled id are checked", () => {
        const p = mk("p-ids");
        expect(() => p.event({ type: "item", item: { id: "a/b", kind: "reply", text: "x" } })).toThrow("id rule");
        expect(() => p.event({ type: "remove", id: "a b" })).toThrow("id rule");
        expect(() => p.event({ type: "settled", inputId: "", status: "answered" })).toThrow("id rule");
        expect(() => p.event({ type: "settled", inputId: "i", requestId: "r/1", status: "answered" })).toThrow("id rule");
        p.close();
      });
      test("an ask with a bad id, tool call id, item id or option id is refused", () => {
        const p = mk("p-ids2");
        expect(() => hold(p, askInput({ id: "a/b" }))).toThrow("id rule");
        expect(() => hold(p, askInput({ toolCallId: "a b" }))).toThrow("id rule");
        expect(() => hold(p, askInput({ itemId: "a#b" }))).toThrow("id rule");
        expect(() => hold(p, askInput({ options: [{ id: "a?b", label: "x", effect: "allow" }] }))).toThrow("id rule");
        expect(() => hold(p, askInput({ options: [] }))).toThrow("at least one");
        expect(() => hold(p, askInput({ options: [options[0]!, options[0]!] }))).toThrow("twice");
        p.close();
      });
      test("a request whose id breaks the rule is 400 bad-id; a missing or mistyped field is 400 bad-body", async () => {
        const good = { requestId: "r1", askId: "a1", revision: 1, answer: { optionId: "allow" } };
        for (const id of ["", "a/b", "a b", "x".repeat(129)]) {
          for (const [path, body] of [
            ["/pane/p1/answer", { ...good, requestId: id }],
            ["/pane/p1/answer", { ...good, askId: id }],
            ["/pane/p1/answer", { ...good, answer: { optionId: id } }],
            ["/pane/p1/send", { requestId: id, text: "x", turnId: "t" }],
            ["/pane/p1/send", { requestId: "r1", text: "x", turnId: id }],
            ["/pane/p1/send", { requestId: "r1", text: "x", askId: id }],
            ["/pane/p1/abort", { requestId: id, turnId: "t" }],
            ["/pane/p1/abort", { requestId: "r1", turnId: id }],
            ["/starter/s1", { requestId: id }],
          ] as const) {
            const r = await post(path, body);
            expect([path, id.length, r.status, r.body.code]).toEqual([path, id.length, 400, "bad-id"]);
          }
        }
        for (const [path, body] of [
          ["/pane/p1/answer", { askId: "a1", revision: 1, answer: { optionId: "allow" } }], // no requestId
          ["/pane/p1/answer", { ...good, requestId: 7 }],
          ["/pane/p1/answer", { ...good, askId: undefined }],
          ["/pane/p1/answer", { ...good, revision: "1" }],
          ["/pane/p1/answer", { ...good, revision: -1 }],
          ["/pane/p1/answer", { ...good, revision: 1.5 }],
          ["/pane/p1/answer", { ...good, revision: undefined }],
          ["/pane/p1/answer", { ...good, answer: "allow" }],
          ["/pane/p1/answer", { ...good, answer: {} }],
          ["/pane/p1/answer", { ...good, answer: { optionId: "allow", note: 3 } }],
          ["/pane/p1/answer", { ...good, answer: { optionId: "allow", note: "n".repeat(2049) } }],
          ["/pane/p1/send", { text: "x", turnId: "t" }],
          ["/starter/s1", {}],
        ] as const) {
          const r = await post(path, body);
          expect([path, JSON.stringify(body), r.status, r.body.code]).toEqual([path, JSON.stringify(body), 400, "bad-body"]);
        }
        expect((await call(d, "POST", "/pane/p1/answer", "[1]")).body.code).toBe("bad-body"); // a body is one object
      });
    });

    describe("snapshot", () => {
      test("lists the layout, the starters, and each pane's turnId", async () => {
        const s = (await api.snapshot(d)).body;
        expect(s.workspaces.map((w) => w.id)).toContain("w");
        expect(s.tabs[0]).toMatchObject({ id: "w:t", workspaceId: "w" });
        expect(s.panes[0]).toMatchObject({ id: "p1", state: "idle", harness: "x", tabId: "w:t", openAsks: [] });
        expect(idOk(s.panes[0]!.turnId)).toBe(true);
        expect(s.starters).toEqual([{ id: "s1", label: "S" }]);
      });
      test("ETag: 304 while nothing changes, 200 after a change", async () => {
        const first = await api.snapshot(d);
        expect(first.etag).toBe(`"${first.body.epoch}-${first.body.rev}"`);
        expect((await api.snapshot(d, first.etag)).status).toBe(304);
        pane.state("working");
        const next = await api.snapshot(d, first.etag);
        expect(next.status).toBe(200);
        expect(next.etag).not.toBe(first.etag);
        expect(next.body.panes[0]!.state).toBe("working");
        pane.state("idle");
      });
      test("rev rises on every visible change: a state, an event, an ask, a new turn, a starter", async () => {
        const p = mk("p-rev");
        const rev = async () => (await api.snapshot(d)).body.rev;
        let last = await rev();
        const rises = async (what: string, act: () => void) => {
          act();
          const now = await rev();
          expect([what, now > last]).toEqual([what, true]);
          last = now;
        };
        await rises("state", () => p.state("working"));
        await rises("event", () => p.event({ type: "item", item: { id: "i", kind: "reply", text: "x" } }));
        await rises("ask", () => hold(p, askInput({ id: "a-rev" })));
        await rises("ask update", () => p.updateAsk("a-rev", { title: "changed" }));
        await rises("starter", () => collie.starters([{ id: "s1", label: "S", run: async () => ({ paneId: "p1" }) }]));
        p.close();
      });
      test("a pane has a turnId from the start, and a new one each time it goes from not working to working", async () => {
        const p = mk("p-turn");
        const t0 = (await paneInfo("p-turn")).turnId;
        expect(idOk(t0)).toBe(true);
        p.state("idle");
        expect((await paneInfo("p-turn")).turnId).toBe(t0); // idle to idle: same turn
        p.state("working");
        const t1 = (await paneInfo("p-turn")).turnId;
        expect(t1).not.toBe(t0);
        p.state("working");
        expect((await paneInfo("p-turn")).turnId).toBe(t1); // still the same turn
        hold(p, askInput({ id: "a-turn" }));
        const waiting = await paneInfo("p-turn");
        expect(waiting.state).toBe("waiting");
        expect(waiting.turnId).toBe(t1); // an ask does not start a turn
        p.state("idle");
        expect((await paneInfo("p-turn")).turnId).toBe(t1); // the last turn that ran
        p.state("working");
        expect((await paneInfo("p-turn")).turnId).not.toBe(t1);
        p.close();
      });
      test("a pane may carry an absolute cwd, and a relative one reads as absent", async () => {
        collie.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p-cwd", { title: "C", harness: "x", cwd: "/srv/work" });
        collie.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p-rel", { title: "R", harness: "x", cwd: "work" });
        expect((await paneInfo("p-cwd")).cwd).toBe("/srv/work");
        expect("cwd" in (await paneInfo("p-rel"))).toBe(false);
        expect("cwd" in (await paneInfo("p1"))).toBe(false);
      });
      test("the snapshot keeps its first 64 workspaces, 256 tabs and 256 panes, and 50 starters", async () => {
        const { collie: c, dial: t } = await transport.open({ hostName: "m" });
        for (let i = 0; i < 70; i++) c.workspace(`w${i}`, { title: "W" });
        const ws = c.workspace("big", { title: "B" });
        for (let i = 0; i < 300; i++) ws.tab(`t${i}`, { title: "T" }).pane(`p${i}`, { title: "P", harness: "x" });
        c.starters(Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, label: "S", run: async () => ({ paneId: "p0" }) })));
        c.ready();
        const s = (await api.snapshot(t)).body;
        expect([s.workspaces.length, s.tabs.length, s.panes.length, s.starters!.length]).toEqual([64, 256, 256, 50]);
        expect(s.workspaces[0]!.id).toBe("w0");
        await c.close();
      });
    });

    describe("events cursor", () => {
      test("after=N returns what is past N and a next cursor", async () => {
        const p = mk("p2");
        p.event({ type: "item", item: { id: "1", kind: "reply", text: "a" } });
        p.event({ type: "item", item: { id: "2", kind: "reply", text: "b" } });
        const all = (await api.events(d, "p2", 0)).body;
        expect(all.events.length).toBe(2);
        expect(all.next).toBe(2);
        expect(all.epoch).toBe(collie.epoch);
        p.event({ type: "item", item: { id: "3", kind: "reply", text: "c" } });
        const tail = (await api.events(d, "p2", all.next)).body;
        expect(tail.events).toEqual([{ type: "item", item: { id: "3", kind: "reply", text: "c" } }]);
        expect(tail.next).toBe(3);
        expect(tail.more).toBeUndefined();
        expect((await api.events(d, "p2", 3)).body.events).toEqual([]);
        const past = (await api.events(d, "p2", 99)).body; // past the count: a reset, and next is the count
        expect(past.reset).toBe(true);
        expect(past.next).toBe(3);
      });
      test("a cursor from another epoch gets reset and the whole current view", async () => {
        const r = (await api.events(d, "p2", 2, "an-old-epoch")).body;
        expect(r.reset).toBe(true);
        expect(r.events.map((e) => e.type)).toEqual(["reset", "item", "item", "item", "state", "synced"]);
        expect(r.next).toBe(3);
        expect(r.epoch).toBe(collie.epoch);
      });
      test("a bad cursor, or no epoch, is 400 bad-cursor", async () => {
        expect((await call(d, "GET", "/pane/p2/events?after=-1&epoch=x")).status).toBe(400);
        expect((await call(d, "GET", "/pane/p2/events?after=0")).body.code).toBe("bad-cursor");
      });
    });

    describe("asks and answers", () => {
      test("an ask carries toolCallId, revision, title and itemId; it sets waiting; answer resolves it by phone; a second answer is 409 decided with the first outcome", async () => {
        const p = mk("p3");
        const pending = p.ask(askInput({ toolCallId: "tc-1", itemId: "item-1", title: "Run it?" }));
        const info = await paneInfo("p3");
        expect(info.state).toBe("waiting");
        const ask = info.openAsks[0]!;
        expect(ask).toMatchObject({ kind: "permission", toolCallId: "tc-1", itemId: "item-1", title: "Run it?", revision: 1 });
        expect(ask.id).toMatch(/^[0-9a-f]{32}$/);
        expect((await api.answer(d, "p3", ask.id, "allow")).body).toEqual({ result: "taken" });
        expect(await pending).toEqual({ optionId: "allow" });
        const second = await api.answer(d, "p3", ask.id, "deny");
        expect(second.status).toBe(409);
        expect(second.body).toMatchObject({ code: "decided", outcome: { decidedBy: "phone", optionId: "allow", effect: "allow" } });
        expect(Date.parse(second.body.outcome!.decidedAt)).not.toBeNaN();
        expect((await api.answer(d, "p3", "never-existed", "allow")).body).toEqual({ result: "too-late" });
        expect((await api.events(d, "p3", 0)).body.events.map((e) => e.type)).toEqual(["ask", "state", "ask-closed", "state"]);
        expect((await paneInfo("p3")).state).toBe("idle");
      });
      test("a stale revision is 409 stale with the current ask, turnId and askIds; the ask stays open", async () => {
        const p = mk("p3-rev");
        const pending = p.ask(askInput({ id: "ask-rev", title: "first" }));
        const other = p.ask(askInput({ id: "ask-other" }));
        expect(p.updateAsk("ask-rev", { title: "second" })).toBe(true);
        expect(p.updateAsk("not-open", { title: "x" })).toBe(false);
        const events = (await api.events(d, "p3-rev", 0)).body.events.filter((e) => e.type === "ask");
        expect(events.map((e) => (e as { ask: { revision: number } }).ask.revision)).toEqual([1, 1, 2]); // an ask event with a higher revision replaces
        const stale = await api.answer(d, "p3-rev", "ask-rev", "allow", { revision: 1 });
        expect(stale.status).toBe(409);
        expect(stale.body.code).toBe("stale");
        expect(stale.body.ask).toMatchObject({ id: "ask-rev", revision: 2, title: "second" });
        expect(stale.body.turnId).toBe((await paneInfo("p3-rev")).turnId);
        expect(stale.body.askIds).toEqual(["ask-rev", "ask-other"]);
        expect((await paneInfo("p3-rev")).openAsks).toHaveLength(2); // nothing ran
        expect((await api.answer(d, "p3-rev", "ask-rev", "allow", { revision: 2 })).body).toEqual({ result: "taken" });
        expect(await pending).toEqual({ optionId: "allow" });
        await api.answer(d, "p3-rev", "ask-other", "deny");
        await other;
      });
      test("a decided ask is 409 decided whatever the revision says, and an unknown one 200 too-late, never another error", async () => {
        const p = mk("p3-late");
        hold(p, askInput({ id: "ask-late" }));
        await api.answer(d, "p3-late", "ask-late", "allow");
        for (const revision of [0, 1, 5]) {
          const r = await api.answer(d, "p3-late", "ask-late", "allow", { revision });
          expect([r.status, r.body.code, r.body.outcome?.decidedBy]).toEqual([409, "decided", "phone"]);
          const unknown = await api.answer(d, "p3-late", "ask-never", "allow", { revision });
          expect([unknown.status, unknown.body]).toEqual([200, { result: "too-late" }]);
        }
      });
      test("an answer that is not an option is 400 bad-option and leaves the ask open", async () => {
        const p = mk("p4");
        const pending = p.ask(askInput({ options: [options[0]!] }));
        const askId = (await paneInfo("p4")).openAsks[0]!.id;
        const r = await api.answer(d, "p4", askId, "bogus");
        expect([r.status, r.body.code]).toEqual([400, "bad-option"]);
        expect((await api.answer(d, "p4", askId, "allow")).body).toEqual({ result: "taken" });
        await pending;
      });
      test("an aborted signal closes the ask as stopped and rejects it", async () => {
        const p = mk("p5");
        const ac = new AbortController();
        const pending = p.ask(askInput(), { signal: ac.signal });
        ac.abort();
        await expect(pending).rejects.toThrow("ask closed: stopped");
        const closed = (await api.events(d, "p5", 0)).body.events.find((e) => e.type === "ask-closed");
        expect(closed).toMatchObject({ by: "stopped" });
        expect((await paneInfo("p5")).state).toBe("idle");
      });
      test("the note reaches the program", async () => {
        const p = mk("p-note");
        const pending = p.ask(askInput());
        const askId = (await paneInfo("p-note")).openAsks[0]!.id;
        await api.answer(d, "p-note", askId, "allow", { note: "go ahead" });
        expect(await pending).toEqual({ optionId: "allow", note: "go ahead" });
      });
      test("the wire carries every open ask up to 50, oldest first, and no more", async () => {
        const p = mk("p-many");
        for (let i = 0; i < 55; i++) hold(p, askInput({ id: `m${i}` }));
        const open = (await paneInfo("p-many")).openAsks;
        expect(open).toHaveLength(50);
        expect(open.map((a) => a.id)).toEqual(Array.from({ length: 50 }, (_, i) => `m${i}`));
        const reset = (await api.events(d, "p-many", 0, "old")).body.events.filter((e) => e.type === "ask");
        expect(reset).toHaveLength(50);
        p.close();
      });
    });

    describe("request id", () => {
      test("a repeated answer returns the first reply with replayed: true and runs nothing", async () => {
        const p = mk("p-rid");
        let resolved = 0;
        const pending = p.ask(askInput({ id: "ask-rid" })).then((a) => (resolved++, a));
        const first = await api.answer(d, "p-rid", "ask-rid", "allow", { requestId: "rid-answer" });
        expect(first.body).toEqual({ result: "taken" });
        const again = await api.answer(d, "p-rid", "ask-rid", "allow", { requestId: "rid-answer", revision: 1 });
        expect([again.status, again.body]).toEqual([200, { result: "taken", replayed: true }]); // not too-late
        expect(await pending).toEqual({ optionId: "allow" });
        expect(resolved).toBe(1);
      });
      test("a repeated too-late answer replays too", async () => {
        const a = await api.answer(d, "p1", "no-ask", "allow", { requestId: "rid-late" });
        expect(a.body).toEqual({ result: "too-late" });
        expect((await api.answer(d, "p1", "no-ask", "allow", { requestId: "rid-late" })).body).toEqual({ result: "too-late", replayed: true });
      });
      test("a repeated send and a repeated abort run once", async () => {
        pane.state("idle");
        const before = sent.length;
        const turnId = (await paneInfo("p1")).turnId;
        const one = await api.send(d, "p1", "once", { turnId, requestId: "rid-send" });
        expect(one.body).toEqual({ ok: true });
        pane.state("working"); // the turn moves on; a replay of the same send still beats the stale check
        pane.state("idle");
        const two = await api.send(d, "p1", "once", { turnId, requestId: "rid-send" });
        expect([two.status, two.body]).toEqual([200, { ok: true, replayed: true }]);
        expect(sent.length - before).toBe(1);

        pane.state("working");
        const stops = aborted;
        const abortTurn = (await paneInfo("p1")).turnId;
        expect((await api.abort(d, "p1", { turnId: abortTurn, requestId: "rid-abort" })).body).toEqual({ ok: true });
        expect((await api.abort(d, "p1", { turnId: abortTurn, requestId: "rid-abort" })).body).toEqual({ ok: true, replayed: true });
        expect(aborted - stops).toBe(1);
        pane.state("idle");
      });
      test("the same request id on another route, pane or starter is 409 request-id-reused", async () => {
        mk("p-reuse");
        const turnId = (await paneInfo("p1")).turnId;
        expect((await api.send(d, "p1", "x", { turnId, requestId: "rid-reuse" })).status).toBe(200);
        for (const r of [
          await api.abort(d, "p1", { turnId, requestId: "rid-reuse" }), // another route
          await api.send(d, "p-reuse", "x", { turnId: (await paneInfo("p-reuse")).turnId, requestId: "rid-reuse" }), // another pane
          await api.start(d, "s1", "rid-reuse"), // a starter
          await api.answer(d, "p1", "a", "allow", { requestId: "rid-reuse" }),
        ]) {
          expect([r.status, r.body.code]).toEqual([409, "request-id-reused"]);
        }
      });
      test("the memory holds at least 500 ids, oldest dropped past its limit", async () => {
        const ids = Array.from({ length: 600 }, (_, i) => `mem-${i}`);
        for (let i = 0; i < ids.length; i += 50) {
          await Promise.all(ids.slice(i, i + 50).map((requestId) => api.answer(d, "p1", "no-ask", "allow", { requestId })));
        }
        // the last 500 are all still known (the first 100 may be gone, none of the last 500 may)
        for (const requestId of ids.slice(-500).filter((_, i) => i % 25 === 0)) {
          const r = await api.answer(d, "p1", "no-ask", "allow", { requestId });
          expect([requestId, r.body.replayed]).toEqual([requestId, true]);
        }
        expect((await api.answer(d, "p1", "no-ask", "allow", { requestId: "mem-0" })).body.replayed).toBe(true); // 600 < the limit of 1000
      });
      test("an error is not remembered: the same request id may try again", async () => {
        const p = mk("p-rid-err");
        const pending = p.ask(askInput({ options: [options[0]!] }));
        const askId = (await paneInfo("p-rid-err")).openAsks[0]!.id;
        expect((await api.answer(d, "p-rid-err", askId, "bogus", { requestId: "rid-err" })).status).toBe(400);
        expect((await api.answer(d, "p-rid-err", askId, "allow", { requestId: "rid-err" })).body).toEqual({ result: "taken" });
        await pending;
      });
    });

    describe("send", () => {
      test("send reaches onSend with the text, steer and the request id", async () => {
        pane.state("idle");
        const before = sent.length;
        const turnId = (await paneInfo("p1")).turnId;
        expect((await api.send(d, "p1", "hello", { steer: true, turnId, requestId: "send-1" })).status).toBe(200);
        expect((await api.send(d, "p1", "later", { turnId, requestId: "send-2" })).status).toBe(200);
        expect((await call(d, "POST", "/pane/p1/send", { requestId: "send-3", text: "x", turnId, when: "steer" })).status).toBe(200); // `when` is not read
        expect(sent.slice(before)).toEqual([["hello", true, "send-1"], ["later", false, "send-2"], ["x", false, "send-3"]]);
      });
      test("exactly one of turnId and askId, a text of 1 to 32768 bytes, a boolean steer", async () => {
        const turnId = (await paneInfo("p1")).turnId;
        const bodies: Record<string, unknown>[] = [
          { requestId: "b1", text: "x" }, // neither
          { requestId: "b2", text: "x", turnId, askId: "a" }, // both
          { requestId: "b3", text: "", turnId },
          { requestId: "b4", text: 5, turnId },
          { requestId: "b5", text: "x".repeat(32769), turnId },
          { requestId: "b6", text: "é".repeat(16385), turnId }, // 32770 bytes in 16385 UTF-16 units
          { requestId: "b7", text: "x", turnId, steer: "yes" },
        ];
        for (const body of bodies) {
          const r = await post("/pane/p1/send", body);
          expect([body.requestId, r.status, r.body.code]).toEqual([body.requestId, 400, "bad-body"]);
        }
        const before = sent.length;
        expect((await post("/pane/p1/send", { requestId: "ok1", text: "x".repeat(32768), turnId })).status).toBe(200);
        expect((await post("/pane/p1/send", { requestId: "ok2", text: "é".repeat(16384), turnId })).status).toBe(200);
        expect(sent.length - before).toBe(2);
      });
      test("a stale turnId or askId is 409 stale with the current turnId and askIds, and nothing runs", async () => {
        const p = mk("p-stale");
        p.onSend((text, o) => void sent.push([text, o.steer, o.requestId]));
        hold(p, askInput({ id: "open-1" }));
        const before = sent.length;
        const now = await paneInfo("p-stale");
        for (const target of [{ turnId: "an-old-turn" }, { askId: "no-such-ask" }]) {
          const r = await api.send(d, "p-stale", "x", target);
          expect([r.status, r.body.code, r.body.turnId, r.body.askIds]).toEqual([409, "stale", now.turnId, ["open-1"]]);
        }
        expect(sent.length).toBe(before);
        // an open ask is a good target, and so is the current turn
        expect((await api.send(d, "p-stale", "to the ask", { askId: "open-1" })).status).toBe(200);
        expect((await api.send(d, "p-stale", "to the turn", { turnId: now.turnId })).status).toBe(200);
        expect(sent.length - before).toBe(2);
        p.close();
      });
      test("send to a pane with no handler is a named 409 not-supported", async () => {
        mk("mute");
        const r = await api.send(d, "mute", "x");
        expect([r.status, r.body.code]).toEqual([409, "not-supported"]);
      });
      test("steer: true with caps.steer false is 409 not-supported; send with caps.send false is too", async () => {
        const { collie: c, dial: t } = await transport.open({ hostName: "c", caps: { ...ALL_CAPS, steer: false } });
        const p = c.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p", { title: "P", harness: "x" });
        let got = 0;
        p.onSend(() => void got++);
        p.onAbort(() => {});
        c.ready();
        expect((await api.hello(t)).body.caps).toMatchObject({ send: true, steer: false, terminal: false });
        const turnId = (await api.snapshot(t)).body.panes[0]!.turnId;
        const steer = await api.send(t, "p", "x", { steer: true, turnId });
        expect([steer.status, steer.body.code]).toEqual([409, "not-supported"]);
        expect((await api.send(t, "p", "x", { steer: false, turnId })).status).toBe(200);
        expect(got).toBe(1);
        await c.close();

        const { collie: none, dial: u } = await transport.open({ hostName: "c", caps: { ...ALL_CAPS, send: false, abort: false, starters: false } });
        const q = none.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p", { title: "P", harness: "x" });
        q.onSend(() => {});
        q.onAbort(() => {});
        none.starters([{ id: "s", label: "S", run: async () => ({ paneId: "p" }) }]);
        none.ready();
        for (const r of [await api.send(u, "p", "x"), await api.abort(u, "p"), await api.start(u, "s")]) {
          expect([r.status, r.body.code]).toEqual([409, "not-supported"]);
        }
        await none.close();
      });
      test("two requests with one id at the same moment run once", async () => {
        const p = mk("p-slow");
        let runs = 0;
        p.onSend(async () => {
          runs++;
          await new Promise((r) => setTimeout(r, 150));
        });
        const turnId = (await paneInfo("p-slow")).turnId;
        const [a, b] = await Promise.all([
          api.send(d, "p-slow", "x", { turnId, requestId: "twin" }),
          api.send(d, "p-slow", "x", { turnId, requestId: "twin" }),
        ]);
        expect(runs).toBe(1);
        expect([a.status, b.status]).toEqual([200, 200]);
        expect([a.body.replayed, b.body.replayed].filter(Boolean)).toEqual([true]);
        p.close();
      });
    });

    describe("abort", () => {
      test("abort carries a request id and a turn; it reaches onAbort when something runs", async () => {
        pane.state("working");
        const before = aborted;
        const turnId = (await paneInfo("p1")).turnId;
        expect((await api.abort(d, "p1", { turnId })).body).toEqual({ ok: true });
        await waitFor("abort", () => aborted === before + 1);
        pane.state("idle");
      });
      test("on a pane with nothing running: { ok: true }, and onAbort does not run", async () => {
        pane.state("idle");
        const before = aborted;
        const r = await api.abort(d, "p1");
        expect([r.status, r.body]).toEqual([200, { ok: true }]);
        expect(aborted).toBe(before);
      });
      test("a body needs a request id and exactly one of turnId and askId", async () => {
        const turnId = (await paneInfo("p1")).turnId;
        for (const body of [{ requestId: "ab1" }, { requestId: "ab2", turnId, askId: "a" }, { turnId }, { requestId: "ab3", turnId: 5 }]) {
          const r = await post("/pane/p1/abort", body);
          expect([JSON.stringify(body), r.status, r.body.code]).toEqual([JSON.stringify(body), 400, "bad-body"]);
        }
      });
      test("a stale turnId or askId is 409 stale and nothing is stopped", async () => {
        pane.state("working");
        const before = aborted;
        const turnId = (await paneInfo("p1")).turnId;
        for (const target of [{ turnId: "an-old-turn" }, { askId: "no-such-ask" }]) {
          const r = await api.abort(d, "p1", target);
          expect([r.status, r.body.code, r.body.turnId, r.body.askIds]).toEqual([409, "stale", turnId, []]);
        }
        expect(aborted).toBe(before);
        pane.state("idle");
      });
      test("abort by askId stops a pane that waits on that ask", async () => {
        const p = mk("p-abort-ask");
        let stopped = 0;
        p.onAbort(() => void stopped++);
        hold(p, askInput({ id: "ask-to-stop" }));
        expect((await api.abort(d, "p-abort-ask", { askId: "ask-to-stop" })).body).toEqual({ ok: true });
        expect(stopped).toBe(1);
        p.close();
      });
    });

    describe("subtitle and badge", () => {
      const rev = async () => (await api.snapshot(d)).body.rev;
      test("a pane starts with neither, and the snapshot carries what the program sets", async () => {
        const p = mk("marks");
        expect(await paneInfo("marks")).not.toHaveProperty("subtitle");
        expect(await paneInfo("marks")).not.toHaveProperty("badge");
        p.subtitle("a customer cannot log in");
        p.badge({ count: 3 });
        expect(await paneInfo("marks")).toMatchObject({ subtitle: "a customer cannot log in", badge: { count: 3 } });
        p.badge({ text: "new" });
        expect((await paneInfo("marks")).badge).toEqual({ text: "new" });
      });
      test("rev rises only when the value changes, and null clears", async () => {
        const p = mk("marks2");
        const before = await rev();
        p.subtitle("one line");
        const afterFirst = await rev();
        expect(afterFirst).toBeGreaterThan(before!);
        p.subtitle("one line");
        p.badge(null); // nothing to clear
        expect(await rev()).toBe(afterFirst);
        p.badge({ count: 2 });
        const afterBadge = await rev();
        expect(afterBadge).toBeGreaterThan(afterFirst!);
        p.badge({ count: 2 });
        expect(await rev()).toBe(afterBadge);
        p.subtitle(null);
        p.badge(null);
        const cleared = await paneInfo("marks2");
        expect(cleared).not.toHaveProperty("subtitle");
        expect(cleared).not.toHaveProperty("badge");
        expect(await rev()).toBeGreaterThan(afterBadge!);
      });
      test("a subtitle and a text badge are cleaned and cut to their caps; a bad count is a RangeError", async () => {
        const p = mk("marks3");
        p.subtitle(`  a\u0000b\u200b${"é".repeat(300)} `);
        const sub = (await paneInfo("marks3")).subtitle!;
        expect([...sub]).toHaveLength(120);
        expect(sub.startsWith("ab")).toBe(true);
        expect(sub.endsWith("…")).toBe(true);
        p.badge({ text: "a-very-long-badge-text" });
        expect((await paneInfo("marks3")).badge).toEqual({ text: "a-very-long…" });
        for (const count of [-1, 10000, 1.5, Number.NaN]) expect(() => p.badge({ count })).toThrow(RangeError);
        expect(() => p.badge({ count: 1, text: "x" } as never)).toThrow(TypeError);
        expect((await paneInfo("marks3")).badge).toEqual({ text: "a-very-long…" }); // a refused value changes nothing
        p.subtitle("   "); // nothing is left of it: cleared
        expect(await paneInfo("marks3")).not.toHaveProperty("subtitle");
      });
    });

    describe("more kinds of ask (WIRE.md 7.14)", () => {
      const QUEUES = [
        { id: "billing", label: "Billing" },
        { id: "access", label: "Access" },
        { id: "other", label: "Other" },
      ];
      let k = 0;
      const base = () => ({ toolCallId: `tc-kind-${++k}`, itemId: `item-kind-${k}`, title: "A question" });
      const openOf = async (pane: string) => (await paneInfo(pane)).openAsks[0]!;

      test("choice: the ask lists plain options, the pane waits, and optionIds resolve it once", async () => {
        const p = mk("kc1");
        const pending = p.ask({ ...base(), kind: "choice", options: QUEUES });
        const ask = await openOf("kc1");
        expect(ask).toMatchObject({ kind: "choice", options: QUEUES });
        expect(ask.options.every((option) => !("effect" in option))).toBe(true);
        expect((await paneInfo("kc1")).state).toBe("waiting");
        const requestId = "11111111-1111-4111-8111-111111111111";
        expect((await api.answerWith(d, "kc1", ask.id, { optionIds: ["access"] }, { requestId })).body).toEqual({ result: "taken" });
        expect((await api.answerWith(d, "kc1", ask.id, { optionIds: ["access"] }, { requestId })).body).toEqual({ result: "taken", replayed: true });
        expect(await pending).toEqual({ optionIds: ["access"] });
        expect((await paneInfo("kc1")).state).toBe("idle");
      });
      test("choice: several picks need multiple; an id the ask does not offer is bad-option; the wrong shape is bad-body; the ask stays open", async () => {
        const p = mk("kc2");
        const single = p.ask({ ...base(), kind: "choice", options: QUEUES });
        const one = await openOf("kc2");
        const two = await api.answerWith(d, "kc2", one.id, { optionIds: ["billing", "access"] });
        expect([two.status, two.body.code]).toEqual([400, "bad-body"]);
        const unknown = await api.answerWith(d, "kc2", one.id, { optionIds: ["nope"] });
        expect([unknown.status, unknown.body.code]).toEqual([400, "bad-option"]);
        for (const answer of [{ optionId: "billing" }, { text: "billing" }, { optionIds: [] }, { optionIds: ["billing", "billing"] }, { optionIds: "billing" }, {}]) {
          expect((await api.answerWith(d, "kc2", one.id, answer)).status).toBe(400);
        }
        expect((await paneInfo("kc2")).openAsks).toHaveLength(1);
        await api.answerWith(d, "kc2", one.id, { optionIds: ["other"] });
        expect(await single).toEqual({ optionIds: ["other"] });

        const m = mk("kc3");
        const multi = m.ask({ ...base(), kind: "choice", options: QUEUES, multiple: true });
        const many = await openOf("kc3");
        expect(many.multiple).toBe(true);
        expect((await api.answerWith(d, "kc3", many.id, { optionIds: ["billing", "other"] })).body).toEqual({ result: "taken" });
        expect(await multi).toEqual({ optionIds: ["billing", "other"] });
      });
      test("text ask: placeholder and maxLength are carried, a text over maxLength or empty is bad-body, a good one resolves", async () => {
        const p = mk("kt1");
        const pending = p.ask({ ...base(), kind: "text", placeholder: "one line", maxLength: 12 });
        const ask = await openOf("kt1");
        expect(ask).toMatchObject({ kind: "text", placeholder: "one line", maxLength: 12, options: [] });
        for (const text of ["", "x".repeat(13), 7, null]) {
          expect((await api.answerWith(d, "kt1", ask.id, { text })).status).toBe(400);
        }
        expect((await paneInfo("kt1")).openAsks).toHaveLength(1);
        expect((await api.answerWith(d, "kt1", ask.id, { text: "all fixed ✓" })).body).toEqual({ result: "taken" });
        expect(await pending).toEqual({ text: "all fixed ✓" });
      });
      test("text ask: maxLength is in characters, not bytes, and absent reads as 500", async () => {
        const p = mk("kt2");
        const pending = p.ask({ ...base(), kind: "text" });
        const ask = await openOf("kt2");
        expect(ask).not.toHaveProperty("maxLength");
        expect((await api.answerWith(d, "kt2", ask.id, { text: "x".repeat(501) })).status).toBe(400);
        expect((await api.answerWith(d, "kt2", ask.id, { text: "é".repeat(500) })).body).toEqual({ result: "taken" });
        expect(await pending).toEqual({ text: "é".repeat(500) });
      });
      test("form: fields are carried, required and types are checked, and values resolve it once", async () => {
        const p = mk("kf1");
        const fields = [
          { id: "summary", label: "Summary", kind: "text" as const, required: true, maxLength: 40 },
          { id: "queue", label: "Queue", kind: "choice" as const, options: QUEUES },
          { id: "urgent", label: "Urgent", kind: "toggle" as const },
        ];
        const pending = p.ask({ ...base(), kind: "form", fields });
        const ask = await openOf("kf1");
        expect(ask).toMatchObject({ kind: "form", options: [], fields });
        const wrong = [
          { code: "bad-body", values: { queue: "billing" } }, // a required field is missing
          { code: "bad-body", values: { summary: "x".repeat(41) } },
          { code: "bad-body", values: { summary: "x", nope: "y" } },
          { code: "bad-body", values: { summary: "x", urgent: "yes" } },
          { code: "bad-body", values: { summary: "x", queue: ["billing"] } },
          { code: "bad-option", values: { summary: "x", queue: "nope" } },
        ];
        for (const { code, values } of wrong) {
          const reply = await api.answerWith(d, "kf1", ask.id, { values });
          expect([reply.status, reply.body.code]).toEqual([400, code]);
        }
        expect((await paneInfo("kf1")).openAsks).toHaveLength(1);
        const values = { summary: "Cannot log in", queue: "access", urgent: true };
        expect((await api.answerWith(d, "kf1", ask.id, { values })).body).toEqual({ result: "taken" });
        expect(await pending).toEqual({ values });
      });
      test("every kind keeps the stable id and the revision rule: the id comes from the pane and toolCallId, and a stale revision is 409", async () => {
        const p = mk("kc4");
        const input = { toolCallId: "tc-stable", itemId: "item-stable", title: "Which queue?", kind: "choice" as const, options: QUEUES };
        const pending = p.ask(input);
        const ask = await openOf("kc4");
        expect(ask.id).toMatch(/^[0-9a-f]{32}$/);
        expect(p.updateAsk(ask.id, { title: "Which queue now?" })).toBe(true);
        const stale = await api.answerWith(d, "kc4", ask.id, { optionIds: ["billing"] }, { revision: 1 });
        expect([stale.status, stale.body.code]).toEqual([409, "stale"]);
        expect(stale.body.ask).toMatchObject({ kind: "choice", revision: 2, title: "Which queue now?", options: QUEUES });
        await api.answerWith(d, "kc4", ask.id, { optionIds: ["billing"] });
        expect(await pending).toEqual({ optionIds: ["billing"] });
      });
      test("the receipt is bound to the payload: one request id with another text, pick or form is 409 request-id-reused", async () => {
        const p = mk("kt3");
        const pending = p.ask({ ...base(), kind: "text" });
        const ask = await openOf("kt3");
        const requestId = "22222222-2222-4222-8222-222222222222";
        expect((await api.answerWith(d, "kt3", ask.id, { text: "first" }, { requestId })).body).toEqual({ result: "taken" });
        const other = await api.answerWith(d, "kt3", ask.id, { text: "second" }, { requestId });
        expect([other.status, other.body.code]).toEqual([409, "request-id-reused"]);
        const shape = await api.answerWith(d, "kt3", ask.id, { optionIds: ["first"] }, { requestId });
        expect([shape.status, shape.body.code]).toEqual([409, "request-id-reused"]);
        await pending;

        const f = mk("kf2");
        const form = f.ask({ ...base(), kind: "form", fields: [{ id: "a", label: "A", kind: "text" }, { id: "b", label: "B", kind: "toggle" }] });
        const open = await openOf("kf2");
        const id = "33333333-3333-4333-8333-333333333333";
        await api.answerWith(d, "kf2", open.id, { values: { a: "1", b: true } }, { requestId: id });
        // The same form with its keys in another order is the same payload.
        expect((await api.answerWith(d, "kf2", open.id, { values: { b: true, a: "1" } }, { requestId: id })).body).toEqual({ result: "taken", replayed: true });
        expect((await api.answerWith(d, "kf2", open.id, { values: { a: "2", b: true } }, { requestId: id })).body.code).toBe("request-id-reused");
        await form;
      });
      test("the core refuses a bad ask at layout time with the section to read: a TypeError, or a RangeError for a count", () => {
        const p = mk("kv1");
        const refuse = (input: object, kind: ErrorConstructor = TypeError) => expect(() => void p.ask({ ...base(), ...input } as never)).toThrow(kind);
        refuse({ kind: "slider" });
        refuse({ kind: "choice", options: [] });
        refuse({ kind: "choice", options: Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, label: "O" })) }, RangeError);
        refuse({ kind: "choice", options: [{ id: "a", label: "A" }, { id: "a", label: "A again" }] });
        refuse({ kind: "choice", options: [{ id: "a", label: "A", effect: "allow" }] });
        refuse({ kind: "choice", options: [{ id: "bad id", label: "A" }] });
        refuse({ kind: "text", options: [{ id: "a", label: "A" }] });
        refuse({ kind: "text", maxLength: 0 }, RangeError);
        refuse({ kind: "text", maxLength: 2001 }, RangeError);
        refuse({ kind: "text", maxLength: 1.5 }, RangeError);
        refuse({ kind: "form", fields: [] });
        refuse({ kind: "form", fields: Array.from({ length: 7 }, (_, i) => ({ id: `f${i}`, label: "F", kind: "toggle" })) }, RangeError);
        refuse({ kind: "form", fields: [{ id: "a", label: "A", kind: "dial" }] });
        refuse({ kind: "form", fields: [{ id: "a", label: "A", kind: "choice" }] });
        refuse({ kind: "form", fields: [{ id: "a", label: "A", kind: "toggle", options: [{ id: "x", label: "X" }] }] });
        refuse({ kind: "form", fields: [{ id: "a", label: "A", kind: "text" }, { id: "a", label: "A", kind: "text" }] });
        refuse({ kind: "form", fields: [{ id: "a", label: "A", kind: "toggle" }], options: [{ id: "x", label: "X" }] });
        expect(p.openAsks).toHaveLength(0);
      });
      test("a placeholder and every label are cleaned and cut", async () => {
        const p = mk("kv2");
        void p.ask({ ...base(), kind: "text", placeholder: `  hint\u200b${"é".repeat(100)}` });
        void p.ask({ ...base(), kind: "form", fields: [{ id: "f", label: `a\u0000${"x".repeat(300)}`, kind: "toggle" }] });
        const [text, form] = (await paneInfo("kv2")).openAsks;
        expect([...(text?.placeholder ?? "")]).toHaveLength(60);
        expect(text?.placeholder?.startsWith("hint")).toBe(true);
        expect(Buffer.byteLength(form?.fields?.[0]?.label ?? "")).toBeLessThanOrEqual(128);
      });
    });

    describe("markdown, code and link items", () => {
      const items = async (id: string) => (await api.events(d, id, 0)).body.events.flatMap((e) => (e.type === "item" ? [e.item] : []));
      test("a pane takes the three kinds, and the events carry them as written", async () => {
        const p = mk("rich");
        p.event({ type: "item", item: { id: "m", kind: "markdown", text: "# Title\n\n- one\n- two" } });
        p.event({ type: "item", item: { id: "c", kind: "code", lang: "ts", text: "const a = 1;\n" } });
        p.event({ type: "item", item: { id: "c2", kind: "code", text: "no language" } });
        p.event({ type: "item", item: { id: "l", kind: "link", href: "https://colliepwa.dev/docs/", label: "Collie docs" } });
        p.event({ type: "item", item: { id: "l2", kind: "link", href: "https://colliepwa.dev/" } });
        expect(await items("rich")).toEqual([
          { id: "m", kind: "markdown", text: "# Title\n\n- one\n- two" },
          { id: "c", kind: "code", lang: "ts", text: "const a = 1;\n" },
          { id: "c2", kind: "code", text: "no language" },
          { id: "l", kind: "link", href: "https://colliepwa.dev/docs/", label: "Collie docs" },
          { id: "l2", kind: "link", href: "https://colliepwa.dev/" },
        ]);
      });
      test("markdown and code text is cleaned and cut at 32 KiB, and a label at 120 characters", async () => {
        const p = mk("rich2");
        p.event({ type: "item", item: { id: "m", kind: "markdown", text: `a\u0000b\u202e${"é".repeat(40_000)}` } });
        p.event({ type: "item", item: { id: "c", kind: "code", text: "x".repeat(40_000) } });
        p.event({ type: "item", item: { id: "l", kind: "link", href: "https://example.com/", label: `  a\u200b${"é".repeat(300)} ` } });
        const [markdown, code, link] = await items("rich2");
        expect(markdown?.kind === "markdown" && markdown.text.startsWith("ab")).toBe(true);
        expect(markdown?.kind === "markdown" && Buffer.byteLength(markdown.text)).toBeLessThanOrEqual(32768);
        expect(code?.kind === "code" && Buffer.byteLength(code.text)).toBeLessThanOrEqual(32768);
        expect(code?.kind === "code" && code.text.endsWith("…")).toBe(true);
        expect(link?.kind === "link" && [...(link.label ?? "")]).toHaveLength(120);
      });
      test("a bad language or a bad link target is a TypeError here, so the wire never carries what the adapter drops", async () => {
        const p = mk("rich3");
        for (const lang of ["", "a".repeat(25), "ts\n```", "c++ x"]) {
          expect(() => p.event({ type: "item", item: { id: "c", kind: "code", lang, text: "x" } })).toThrow(TypeError);
        }
        const hrefs = ["http://example.com/", "javascript:alert(1)", "data:text/html,x", "//example.com/", "/docs", "https://", "https://u:p@example.com/", "https://example.com/a b", `https://example.com/${"a".repeat(2100)}`, ""];
        for (const href of hrefs) expect(() => p.event({ type: "item", item: { id: "l", kind: "link", href } })).toThrow(TypeError);
        expect(await items("rich3")).toEqual([]); // a refused item is not in the log
      });
    });

    describe("progress", () => {
      const rev = async () => (await api.snapshot(d)).body.rev;
      test("a pane starts without progress, and the snapshot carries steps and a percent", async () => {
        const p = mk("prog");
        expect(await paneInfo("prog")).not.toHaveProperty("progress");
        p.progress({ kind: "steps", steps: [{ label: "read", state: "done" }, { label: "write", state: "running" }, { label: "reply", state: "todo" }] });
        expect((await paneInfo("prog")).progress).toEqual({
          kind: "steps",
          steps: [{ label: "read", state: "done" }, { label: "write", state: "running" }, { label: "reply", state: "todo" }],
        });
        p.progress({ kind: "percent", value: 40, label: "uploading" });
        expect((await paneInfo("prog")).progress).toEqual({ kind: "percent", value: 40, label: "uploading" });
      });
      test("rev rises only when the value changes, and null clears", async () => {
        const p = mk("prog2");
        const before = await rev();
        p.progress(null); // nothing to clear
        expect(await rev()).toBe(before);
        p.progress({ kind: "percent", value: 10 });
        const first = await rev();
        expect(first).toBeGreaterThan(before!);
        p.progress({ kind: "percent", value: 10 });
        expect(await rev()).toBe(first);
        p.progress({ kind: "percent", value: 11 });
        const second = await rev();
        expect(second).toBeGreaterThan(first!);
        p.progress(null);
        expect(await paneInfo("prog2")).not.toHaveProperty("progress");
        expect(await rev()).toBeGreaterThan(second!);
      });
      test("labels are cleaned and cut, steps past the 12th are left out, and a bad shape is refused", async () => {
        const p = mk("prog3");
        const many = Array.from({ length: 15 }, (_, i) => ({ label: `step ${i}`, state: "todo" as const }));
        p.progress({ kind: "steps", steps: many });
        const steps = ((await paneInfo("prog3")).progress as { steps: { label: string }[] }).steps;
        expect(steps).toHaveLength(12);
        p.progress({ kind: "percent", value: 5, label: `a\u200b${"é".repeat(100)}` });
        const label = ((await paneInfo("prog3")).progress as { label: string }).label;
        expect([...label]).toHaveLength(60);
        expect(label.endsWith("…")).toBe(true);
        p.progress({ kind: "percent", value: 6, label: "\u200b" }); // nothing left of the label: the percent stays
        expect((await paneInfo("prog3")).progress).toEqual({ kind: "percent", value: 6 });
        for (const value of [-1, 101, Number.NaN]) expect(() => p.progress({ kind: "percent", value })).toThrow(RangeError);
        expect(() => p.progress({ kind: "steps", steps: [] })).toThrow(TypeError);
        expect(() => p.progress({ kind: "steps", steps: [{ label: "a", state: "paused" as never }] })).toThrow(TypeError);
        expect(() => p.progress({ kind: "steps", steps: [{ label: "\u200b", state: "done" }] })).toThrow(TypeError);
        expect(() => p.progress({ kind: "ring" } as never)).toThrow(TypeError);
        expect((await paneInfo("prog3")).progress).toEqual({ kind: "percent", value: 6 }); // a refused value changes nothing
      });
    });

    describe("rename", () => {
      const snap = async () => (await api.snapshot(d)).body;
      test("rename a tab: the snapshot shows the title and rev rose; panes keep their own title", async () => {
        mk("p-rename");
        const before = await snap();
        const r = await api.rename(d, "tab", "w:t", "  Renamed tab  ", "rename-tab-1");
        expect([r.status, r.body]).toEqual([200, { ok: true }]);
        const after = await snap();
        expect(after.tabs.find((t) => t.id === "w:t")!.title).toBe("Renamed tab"); // trimmed
        expect(after.rev).toBeGreaterThan(before.rev);
        expect(after.panes.find((p) => p.id === "p-rename")!.title).toBe("P-RENAME"); // a pane's title is the conversation's
        expect(after.workspaces.find((w) => w.id === "w")!.title).toBe("W");
      });
      test("rename a workspace", async () => {
        const before = await snap();
        expect((await api.rename(d, "workspace", "w", "Renamed workspace")).status).toBe(200);
        const after = await snap();
        expect(after.workspaces.find((w) => w.id === "w")!.title).toBe("Renamed workspace");
        expect(after.rev).toBeGreaterThan(before.rev);
      });
      test("a repeat of the request id answers from the receipt, asks the hook once, and does not move rev", async () => {
        const askedBefore = asked.length;
        const first = await api.rename(d, "tab", "w:t", "Once", "rename-once");
        expect(first.body).toEqual({ ok: true });
        const rev = (await snap()).rev;
        const again = await api.rename(d, "tab", "w:t", "Once", "rename-once");
        expect([again.status, again.body]).toEqual([200, { ok: true, replayed: true }]);
        expect(asked.length - askedBefore).toBe(1);
        expect((await snap()).rev).toBe(rev);
      });
      test("the same request id for another title or target is 409 request-id-reused", async () => {
        expect((await api.rename(d, "tab", "w:t", "Same id", "rename-reuse")).status).toBe(200);
        for (const r of [await api.rename(d, "tab", "w:t", "Another title", "rename-reuse"), await api.rename(d, "workspace", "w", "Same id", "rename-reuse")]) {
          expect([r.status, r.body.code]).toEqual([409, "request-id-reused"]);
        }
      });
      test("the hook answering false is 422 rename-refused, nothing changes, and the same id may try again", async () => {
        const title = (await snap()).tabs.find((t) => t.id === "w:t")!.title;
        renameVerdict = false;
        const refused = await api.rename(d, "tab", "w:t", "Not allowed", "rename-no");
        expect([refused.status, refused.body.code]).toEqual([422, "rename-refused"]);
        expect((await snap()).tabs.find((t) => t.id === "w:t")!.title).toBe(title);
        renameVerdict = Promise.resolve(true); // a hook may answer late
        expect((await api.rename(d, "tab", "w:t", "Not allowed", "rename-no")).body).toEqual({ ok: true });
        expect((await snap()).tabs.find((t) => t.id === "w:t")!.title).toBe("Not allowed");
        renameVerdict = true;
      });
      test("an unknown workspace or tab is 404 no-such-target, and the hook is not asked", async () => {
        const askedBefore = asked.length;
        for (const [kind, id] of [["tab", "w:nope"], ["tab", "w"], ["workspace", "w:t"], ["workspace", "nope"]] as const) {
          const r = await api.rename(d, kind, id, "X");
          expect([kind, id, r.status, r.body.code]).toEqual([kind, id, 404, "no-such-target"]);
        }
        expect(asked.length).toBe(askedBefore);
      });
      test("a bad title is 400 bad-body: not a string, empty, blank, over 120 characters, or with a control character", async () => {
        for (const title of [undefined, null, 7, "", "   ", "x".repeat(121), "a\nb", "a\u0000b", "a\u007fb", "a\u0085b", "\u200b\u200b"]) {
          const r = await api.rename(d, "tab", "w:t", title);
          expect([JSON.stringify(title), r.status, r.body.code]).toEqual([JSON.stringify(title), 400, "bad-body"]);
        }
        expect((await api.rename(d, "tab", "w:t", "x".repeat(120))).status).toBe(200); // exactly 120 is fine
        expect((await api.rename(d, "tab", "w:t", "é".repeat(120))).status).toBe(200); // characters, not bytes
        expect((await api.rename(d, "tab", "w:t", "T")).status).toBe(200);
      });
      test("caps.rename false: hello says so and the route is 409 not-supported", async () => {
        const { collie: c, dial: t } = await transport.open({ hostName: "c", caps: { ...ALL_CAPS, rename: false } });
        c.workspace("w", { title: "W" }).tab("t", { title: "T" });
        c.ready();
        expect((await api.hello(t)).body.caps).toMatchObject({ rename: false });
        const r = await api.rename(t, "tab", "w:t", "X");
        expect([r.status, r.body.code]).toEqual([409, "not-supported"]);
        expect((await api.snapshot(t)).body.tabs[0]!.title).toBe("T");
        await c.close();
      });
      test("a bad body is 400: a kind that is neither workspace nor tab, a missing or mistyped field, an id that breaks the rule", async () => {
        const cases: [unknown, string][] = [
          [{ requestId: "r", kind: "pane", id: "p1", title: "X" }, "bad-body"],
          [{ requestId: "r", id: "w", title: "X" }, "bad-body"],
          [{ requestId: "r", kind: "tab", title: "X" }, "bad-body"],
          [{ kind: "tab", id: "w:t", title: "X" }, "bad-body"],
          [{ requestId: "r", kind: "tab", id: 4, title: "X" }, "bad-body"],
          [{ requestId: "bad id", kind: "tab", id: "w:t", title: "X" }, "bad-id"],
          [{ requestId: "r", kind: "tab", id: "a b", title: "X" }, "bad-id"],
        ];
        for (const [body, code] of cases) {
          const r = await post("/rename", body);
          expect([JSON.stringify(body), r.status, r.body.code]).toEqual([JSON.stringify(body), 400, code]);
        }
      });
    });

    describe("close", () => {
      const snap = async () => (await api.snapshot(d)).body;
      /** A workspace of its own with one tab and the given panes, so a close does not touch the shared "w". */
      const layout = (ws: string, panes: string[] = ["a", "b"]) => {
        const tab = collie.workspace(ws, { title: ws.toUpperCase() }).tab("t", { title: "T" });
        return panes.map((id) => tab.pane(`${ws}-${id}`, { title: id, harness: "x" }));
      };
      const ids = (list: { id: string }[]) => list.map((x) => x.id);

      test("close a pane: it leaves the snapshot, rev rose, its tab and the other pane stay, and its log is gone", async () => {
        layout("c1");
        const before = await snap();
        const r = await api.close(d, "pane", "c1-a", "close-pane-1");
        expect([r.status, r.body]).toEqual([200, { ok: true }]);
        const after = await snap();
        expect(ids(after.panes).includes("c1-a")).toBe(false);
        expect(ids(after.panes).includes("c1-b")).toBe(true);
        expect(ids(after.tabs).includes("c1:t")).toBe(true);
        expect(after.rev).toBeGreaterThan(before.rev);
        expect((await api.events(d, "c1-a", 0)).body.code).toBe("no-such-pane");
      });
      test("close a tab: the tab and the panes inside it go, the rest stay", async () => {
        layout("c2");
        const other = collie.workspace("c2", { title: "C2" }).tab("u", { title: "U" }).pane("c2-keep", { title: "keep", harness: "x" });
        const r = await api.close(d, "tab", "c2:t");
        expect(r.body).toEqual({ ok: true });
        const after = await snap();
        expect(ids(after.tabs).filter((x) => x.startsWith("c2:"))).toEqual(["c2:u"]);
        expect(ids(after.panes).filter((x) => x.startsWith("c2-"))).toEqual([other.id]);
        expect(ids(after.workspaces).includes("c2")).toBe(true);
      });
      test("close a workspace: its tabs and panes go with it", async () => {
        layout("c3");
        const r = await api.close(d, "workspace", "c3");
        expect(r.body).toEqual({ ok: true });
        const after = await snap();
        expect(ids(after.workspaces).includes("c3")).toBe(false);
        expect(ids(after.tabs).filter((x) => x.startsWith("c3:"))).toEqual([]);
        expect(ids(after.panes).filter((x) => x.startsWith("c3-"))).toEqual([]);
      });
      test("every open ask on a closed pane closes as stopped, and nobody answers it", async () => {
        const [a, b] = layout("c4");
        const waiting = [hold(a!, askInput({ id: "c4-ask-1" })), hold(b!, askInput({ id: "c4-ask-2" }))];
        const outcomes = Promise.allSettled(waiting);
        expect((await api.close(d, "tab", "c4:t")).body).toEqual({ ok: true });
        const settled = await outcomes;
        for (const s of settled) {
          expect(s.status).toBe("rejected");
          expect((s as PromiseRejectedResult).reason).toMatchObject({ by: "stopped" });
        }
        // The asks are gone with the panes: an answer finds no pane.
        expect((await api.answer(d, "c4-a", "c4-ask-1", "allow", { revision: 1 })).status).toBe(404);
      });
      test("the hook gets the target, the panes that go with it, and the request id", async () => {
        layout("c5");
        const before = closeAsked.length;
        await api.close(d, "tab", "c5:t", "close-hook-1");
        await api.close(d, "pane", "c1-b", "close-hook-2");
        expect(closeAsked.slice(before)).toEqual([
          { kind: "tab", id: "c5:t", paneIds: ["c5-a", "c5-b"], requestId: "close-hook-1" },
          { kind: "pane", id: "c1-b", paneIds: ["c1-b"], requestId: "close-hook-2" },
        ]);
      });
      test("a repeat of the request id answers from the receipt, asks the hook once, and does not move rev", async () => {
        layout("c6");
        const askedBefore = closeAsked.length;
        expect((await api.close(d, "pane", "c6-a", "close-once")).body).toEqual({ ok: true });
        const rev = (await snap()).rev;
        const again = await api.close(d, "pane", "c6-a", "close-once");
        expect([again.status, again.body]).toEqual([200, { ok: true, replayed: true }]);
        expect(closeAsked.length - askedBefore).toBe(1);
        expect((await snap()).rev).toBe(rev);
        // A new request id for a target that is gone is a plain 404.
        expect((await api.close(d, "pane", "c6-a")).body.code).toBe("no-such-target");
      });
      test("the same request id for another kind or target is 409 request-id-reused", async () => {
        layout("c7");
        expect((await api.close(d, "pane", "c7-a", "close-reuse")).status).toBe(200);
        for (const r of [await api.close(d, "pane", "c7-b", "close-reuse"), await api.close(d, "tab", "c7:t", "close-reuse")]) {
          expect([r.status, r.body.code]).toEqual([409, "request-id-reused"]);
        }
      });
      test("the hook answering false is 422 close-refused, nothing changes, and the same id may try again", async () => {
        layout("c8");
        const before = await snap();
        closeVerdict = false;
        const refused = await api.close(d, "pane", "c8-a", "close-no");
        expect([refused.status, refused.body.code]).toEqual([422, "close-refused"]);
        const after = await snap();
        expect(ids(after.panes).includes("c8-a")).toBe(true);
        expect(after.rev).toBe(before.rev);
        closeVerdict = Promise.resolve(true); // a hook may answer late, and `true` accepts
        expect((await api.close(d, "pane", "c8-a", "close-no")).body).toEqual({ ok: true });
        expect(ids((await snap()).panes).includes("c8-a")).toBe(false);
        closeVerdict = undefined;
      });
      test("an unknown target is 404 no-such-target, a target of the wrong kind too, and the hook is not asked", async () => {
        layout("c9");
        const askedBefore = closeAsked.length;
        for (const [kind, id] of [["pane", "nope"], ["pane", "c9:t"], ["tab", "c9"], ["tab", "c9:nope"], ["workspace", "c9:t"], ["workspace", "nope"]] as const) {
          const r = await api.close(d, kind, id);
          expect([kind, id, r.status, r.body.code]).toEqual([kind, id, 404, "no-such-target"]);
        }
        expect(closeAsked.length).toBe(askedBefore);
      });
      test("a bad body is 400: a kind that is not pane, tab or workspace, a missing or mistyped field, an id that breaks the rule", async () => {
        const cases: [unknown, string][] = [
          [{ requestId: "r", kind: "space", id: "w" }, "bad-body"],
          [{ requestId: "r", id: "w" }, "bad-body"],
          [{ requestId: "r", kind: "tab" }, "bad-body"],
          [{ kind: "tab", id: "w:t" }, "bad-body"],
          [{ requestId: "r", kind: "tab", id: 4 }, "bad-body"],
          [{ requestId: "bad id", kind: "tab", id: "w:t" }, "bad-id"],
          [{ requestId: "r", kind: "tab", id: "a b" }, "bad-id"],
        ];
        for (const [body, code] of cases) {
          const r = await post("/close", body);
          expect([JSON.stringify(body), r.status, r.body.code]).toEqual([JSON.stringify(body), 400, code]);
        }
      });
      test("caps.close false: hello says so and the route is 409 not-supported", async () => {
        const { collie: c, dial: t } = await transport.open({ hostName: "c", caps: { ...ALL_CAPS, close: false } });
        c.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p", { title: "P", harness: "x" });
        c.ready();
        expect((await api.hello(t)).body.caps).toMatchObject({ close: false });
        const r = await api.close(t, "pane", "p");
        expect([r.status, r.body.code]).toEqual([409, "not-supported"]);
        expect((await api.snapshot(t)).body.panes.map((p) => p.id)).toEqual(["p"]);
        await c.close();
      });
      test("with no hook at all a close just removes the target", async () => {
        const { collie: c, dial: t } = await transport.open({ hostName: "n" });
        c.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p", { title: "P", harness: "x" });
        c.ready();
        expect((await api.close(t, "pane", "p")).body).toEqual({ ok: true });
        expect((await api.snapshot(t)).body.panes).toEqual([]);
        await c.close();
      });
    });

    describe("actions", () => {
      const ESC = { id: "escalate", label: "Escalate", icon: "flag" } as const;
      type Hooked = NonNullable<CoreOptions["hooks"]>;
      /** A core with one pane, the given belt actions, and the given hook or per-pane handler. */
      const withActions = async (list: PaneAction[] | null, hooks: Hooked = {}, caps?: Partial<Caps>) => {
        const opened = await transport.open({ hostName: "a", hooks, caps });
        const p = opened.collie.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("ap", { title: "AP", harness: "x" });
        if (list !== null) p.actions(list);
        opened.collie.ready();
        const info = async () => (await api.snapshot(opened.dial)).body.panes[0]!;
        return { ...opened, p, info };
      };

      test("a pane's actions are in the snapshot in the program's order, and a pane with none carries no key", async () => {
        const { collie: c, p, info } = await withActions([ESC, { id: "pause", label: "Pause", icon: "pause" }]);
        expect((await info()).actions).toEqual([ESC, { id: "pause", label: "Pause", icon: "pause" }]);
        p.actions(null);
        expect("actions" in (await info())).toBe(false);
        await c.close();
      });
      test("at most 4 actions, a label cut to 16 characters, an unknown icon dropped, an empty label and a repeated id left out", async () => {
        const many = ["a", "b", "c", "d", "e"].map((id) => ({ id, label: id }));
        const { collie: c, p, info } = await withActions(many);
        expect((await info()).actions!.map((a) => a.id)).toEqual(["a", "b", "c", "d"]);
        p.actions([
          { id: "long", label: "  A label that is far too long  ", icon: "nope" as never },
          { id: "empty", label: "   " },
          { id: "long", label: "Again" },
          { id: "busy", label: "Run", icon: "play", busy: true, disabled: true },
        ]);
        expect((await info()).actions).toEqual([
          { id: "long", label: "A label that is" },
          { id: "busy", label: "Run", icon: "play", busy: true, disabled: true },
        ]);
        expect(() => p.actions([{ id: "bad id", label: "x" }])).toThrow();
        await c.close();
      });
      test("rev rises when the list changes, and not when it is set again to the same thing", async () => {
        const { collie: c, p, dial: t } = await withActions([ESC]);
        const rev = async () => (await api.snapshot(t)).body.rev;
        const first = await rev();
        p.actions([{ ...ESC }]);
        expect(await rev()).toBe(first);
        p.actions([{ ...ESC, disabled: true }]);
        expect(await rev()).toBeGreaterThan(first);
        await c.close();
      });
      test("a tap runs the hook once with the typed payload, and a repeat of the request id answers from the receipt", async () => {
        const got: unknown[] = [];
        const { collie: c, dial: t, info } = await withActions([ESC], { onAction: (pane, action) => void got.push({ id: pane.id, action }) });
        const turnId = (await info()).turnId;
        const first = await api.action(t, "ap", "escalate", { turnId, requestId: "act-1" });
        expect([first.status, first.body]).toEqual([200, { ok: true }]);
        const again = await api.action(t, "ap", "escalate", { turnId, requestId: "act-1" });
        expect([again.status, again.body]).toEqual([200, { ok: true, replayed: true }]);
        expect(got).toEqual([{ id: "ap", action: { actionId: "escalate", turnId, requestId: "act-1" } }]);
        // No turn named: the pane's button is the target, and that is allowed.
        expect((await api.action(t, "ap", "escalate", { requestId: "act-2" })).body).toEqual({ ok: true });
        expect(got.length).toBe(2);
        await c.close();
      });
      test("a pane's own handler wins over the hook, and the same request id for another action is 409 request-id-reused", async () => {
        const viaHook: string[] = [];
        const viaPane: string[] = [];
        const { collie: c, dial: t, p } = await withActions([ESC, { id: "pause", label: "Pause" }], { onAction: (_pane, a) => void viaHook.push(a.actionId) });
        p.onAction((a) => void viaPane.push(a.actionId));
        expect((await api.action(t, "ap", "escalate", { requestId: "act-3" })).status).toBe(200);
        expect([viaPane, viaHook]).toEqual([["escalate"], []]);
        const reused = await api.action(t, "ap", "pause", { requestId: "act-3" });
        expect([reused.status, reused.body.code]).toEqual([409, "request-id-reused"]);
        await c.close();
      });
      test("a stale turn is 409 stale with the current turn, and the hook is not run", async () => {
        const got: string[] = [];
        const { collie: c, dial: t, p, info } = await withActions([ESC], { onAction: (_pane, a) => void got.push(a.actionId) });
        const old = (await info()).turnId;
        p.state("working");
        const now = (await info()).turnId;
        expect(now).not.toBe(old);
        const r = await api.action(t, "ap", "escalate", { turnId: old });
        expect([r.status, r.body.code, r.body.turnId]).toEqual([409, "stale", now]);
        expect(got).toEqual([]);
        await c.close();
      });
      test("an unknown pane is 404 no-such-pane, an action the pane does not list is 404 no-such-action", async () => {
        const got: string[] = [];
        const { collie: c, dial: t } = await withActions([ESC], { onAction: (_pane, a) => void got.push(a.actionId) });
        expect((await api.action(t, "nope", "escalate")).body.code).toBe("no-such-pane");
        const r = await api.action(t, "ap", "other");
        expect([r.status, r.body.code]).toEqual([404, "no-such-action"]);
        expect(got).toEqual([]);
        await c.close();
      });
      test("the hook answering false is 422 action-refused, and the same request id may try again", async () => {
        let verdict: boolean | undefined = false;
        const { collie: c, dial: t } = await withActions([ESC], { onAction: () => verdict });
        const refused = await api.action(t, "ap", "escalate", { requestId: "act-4" });
        expect([refused.status, refused.body.code]).toEqual([422, "action-refused"]);
        verdict = undefined; // a hook that returns nothing accepts
        expect((await api.action(t, "ap", "escalate", { requestId: "act-4" })).body).toEqual({ ok: true });
        await c.close();
      });
      test("a disabled or busy action takes no tap: 422 action-refused, and the hook is not run", async () => {
        const got: string[] = [];
        const { collie: c, dial: t } = await withActions(
          [
            { id: "off", label: "Off", disabled: true },
            { id: "run", label: "Run", busy: true },
          ],
          { onAction: (_pane, a) => void got.push(a.actionId) },
        );
        for (const id of ["off", "run"]) {
          const r = await api.action(t, "ap", id);
          expect([id, r.status, r.body.code]).toEqual([id, 422, "action-refused"]);
        }
        expect(got).toEqual([]);
        await c.close();
      });
      test("with caps.actions false, or no handler and no hook, the route is 409 not-supported", async () => {
        const off = await withActions([ESC], { onAction: () => true }, { actions: false });
        expect((await api.hello(off.dial)).body.caps).toMatchObject({ actions: false });
        expect((await api.action(off.dial, "ap", "escalate")).body.code).toBe("not-supported");
        await off.collie.close();
        const bare = await withActions([ESC]);
        expect((await api.action(bare.dial, "ap", "escalate")).body.code).toBe("not-supported");
        await bare.collie.close();
      });
      test("a bad body is 400: no action id, a mistyped field, an id that breaks the rule, no request id", async () => {
        const { collie: c, dial: t } = await withActions([ESC], { onAction: () => true });
        const cases: [unknown, string][] = [
          [{ requestId: "r" }, "bad-body"],
          [{ requestId: "r", actionId: 4 }, "bad-body"],
          [{ requestId: "r", actionId: "a b" }, "bad-id"],
          [{ requestId: "r", actionId: "escalate", turnId: 4 }, "bad-body"],
          [{ actionId: "escalate" }, "bad-body"],
        ];
        for (const [body, code] of cases) {
          const r = await call(t, "POST", "/pane/ap/action", body);
          expect([JSON.stringify(body), r.status, r.body.code]).toEqual([JSON.stringify(body), 400, code]);
        }
        await c.close();
      });
    });

    describe("hooks", () => {
      /** A core whose program sets hooks and no per-pane handler, and the dial that reaches it. */
      const withHooks = async (hooks: NonNullable<CoreOptions["hooks"]>, caps?: Partial<Caps>) => {
        const opened = await transport.open({ hostName: "h", hooks, caps });
        const p = opened.collie.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("hp", { title: "HP", harness: "x" });
        opened.collie.ready();
        return { ...opened, p };
      };
      test("onSend runs for a pane with no handler, with a typed payload: text, steer, the turn and the request id", async () => {
        const got: unknown[] = [];
        const { collie: c, dial: t, p } = await withHooks({ onSend: (pane, req) => void got.push({ pane, req }) });
        p.state("working");
        const turnId = (await api.snapshot(t)).body.panes[0]!.turnId;
        expect((await api.send(t, "hp", "hello", { turnId, steer: true, requestId: "hook-send-1" })).body).toEqual({ ok: true });
        expect(got).toEqual([
          {
            pane: { id: "hp", workspaceId: "w", tabId: "w:t", title: "HP", harness: "x", turnId },
            req: { text: "hello", steer: true, turnId, requestId: "hook-send-1" },
          },
        ]);
        // A repeat of the request id answers from the receipt and does not reach the hook again.
        expect((await api.send(t, "hp", "hello", { turnId, steer: true, requestId: "hook-send-1" })).body).toEqual({ ok: true, replayed: true });
        expect(got.length).toBe(1);
        await c.close();
      });
      test("onAbort runs for a pane with no handler, and not on an idle pane", async () => {
        const got: unknown[] = [];
        const { collie: c, dial: t, p } = await withHooks({ onAbort: (pane, req) => void got.push({ id: pane.id, req }) });
        const turnId = (await api.snapshot(t)).body.panes[0]!.turnId;
        expect((await api.abort(t, "hp", { turnId, requestId: "hook-abort-0" })).body).toEqual({ ok: true });
        expect(got).toEqual([]); // nothing runs: nothing to stop
        p.state("working");
        const running = (await api.snapshot(t)).body.panes[0]!.turnId;
        expect((await api.abort(t, "hp", { turnId: running, requestId: "hook-abort-1" })).body).toEqual({ ok: true });
        expect(got).toEqual([{ id: "hp", req: { turnId: running, requestId: "hook-abort-1" } }]);
        await c.close();
      });
      test("a pane's own handler wins over the hook", async () => {
        const viaHook: string[] = [];
        const viaPane: string[] = [];
        const { collie: c, dial: t, p } = await withHooks({ onSend: (_pane, req) => void viaHook.push(req.text) });
        p.onSend((text) => void viaPane.push(text));
        expect((await api.send(t, "hp", "to the pane")).status).toBe(200);
        expect([viaPane, viaHook]).toEqual([["to the pane"], []]);
        await c.close();
      });
      test("a pane with no handler and no hook is still 409 not-supported", async () => {
        const { collie: c, dial: t } = await withHooks({ onRename: () => true });
        expect((await api.send(t, "hp", "x")).body.code).toBe("not-supported");
        expect((await api.abort(t, "hp")).body.code).toBe("not-supported");
        await c.close();
      });
      test("onRename gets the request id, and false is 422", async () => {
        const got: unknown[] = [];
        const { collie: c, dial: t } = await withHooks({
          onRename: (target, requestId) => {
            got.push({ target, requestId });
            return target.title !== "No";
          },
        });
        expect((await api.rename(t, "tab", "w:t", "Yes", "hook-rename-1")).body).toEqual({ ok: true });
        expect(got).toEqual([{ target: { kind: "tab", id: "w:t", title: "Yes" }, requestId: "hook-rename-1" }]);
        expect((await api.rename(t, "tab", "w:t", "No", "hook-rename-2")).body.code).toBe("rename-refused");
        await c.close();
      });
      test("the old onRename option still works as an alias, and hooks.onRename wins when both are set", async () => {
        const old: unknown[] = [];
        const first = await transport.open({ hostName: "a", onRename: (target) => (old.push(target), false) });
        first.collie.workspace("w", { title: "W" }).tab("t", { title: "T" });
        first.collie.ready();
        expect((await api.rename(first.dial, "tab", "w:t", "X")).body.code).toBe("rename-refused");
        expect(old).toEqual([{ kind: "tab", id: "w:t", title: "X" }]);
        await first.collie.close();
        const both = await transport.open({ hostName: "b", hooks: { onRename: () => true }, onRename: () => false });
        both.collie.workspace("w", { title: "W" }).tab("t", { title: "T" });
        both.collie.ready();
        expect((await api.rename(both.dial, "tab", "w:t", "X")).status).toBe(200);
        await both.collie.close();
      });
    });

    describe("starter and request id", () => {
      test("a starter returns the pane it made", async () => {
        expect((await api.start(d, "s1")).body).toEqual({ paneId: "p1" });
      });
      test("a repeat with the same request id returns the first paneId with replayed: true and runs nothing", async () => {
        let made = 0;
        collie.starters([
          {
            id: "once",
            label: "Once",
            run: async () => {
              made++;
              mk(`made-${made}`);
              return { paneId: `made-${made}` };
            },
          },
          { id: "other", label: "Other", run: async () => ({ paneId: "p1" }) },
        ]);
        const first = await api.start(d, "once", "start-1");
        expect(first.body).toEqual({ paneId: "made-1" });
        const again = await api.start(d, "once", "start-1");
        expect(again.body).toEqual({ paneId: "made-1", replayed: true });
        expect(made).toBe(1);
        expect((await api.start(d, "once", "start-2")).body).toEqual({ paneId: "made-2" }); // another id runs again
        expect(made).toBe(2);
        expect((await api.start(d, "other", "start-1")).body.code).toBe("request-id-reused");
      });
      test("a failure is 422 starter-failed with its message, stores nothing, and the same id may run again", async () => {
        let tries = 0;
        collie.starters([
          {
            id: "flaky",
            label: "Flaky",
            run: async () => {
              if (++tries === 1) throw new Error(`boom\u0000 ${"x".repeat(1000)}`);
              return { paneId: "p1" };
            },
          },
        ]);
        const failed = await api.start(d, "flaky", "start-flaky");
        expect([failed.status, failed.body.code]).toEqual([422, "starter-failed"]);
        expect(failed.body.message).toStartWith("boom xxx");
        expect(Buffer.byteLength(failed.body.message!)).toBeLessThanOrEqual(512);
        expect((await api.start(d, "flaky", "start-flaky")).body).toEqual({ paneId: "p1" }); // ran again
        expect((await api.start(d, "flaky", "start-flaky")).body).toEqual({ paneId: "p1", replayed: true });
        expect(tries).toBe(2);
      });
      test("a starter that names a pane that is not in the layout fails with 422", async () => {
        collie.starters([{ id: "ghost", label: "Ghost", run: async () => ({ paneId: "nowhere" }) }]);
        expect((await api.start(d, "ghost")).status).toBe(422);
      });
      test("a repeat while the first is still starting waits for it, and nothing runs twice", async () => {
        let runs = 0;
        collie.starters([
          {
            id: "slow",
            label: "Slow",
            run: async () => {
              runs++;
              await new Promise((r) => setTimeout(r, 200));
              return { paneId: "p1" };
            },
          },
        ]);
        const [a, b] = await Promise.all([api.start(d, "slow", "start-slow"), api.start(d, "slow", "start-slow")]);
        expect([a.body.paneId, b.body.paneId]).toEqual(["p1", "p1"]);
        expect([a.body.replayed, b.body.replayed].filter(Boolean)).toEqual([true]);
        expect(runs).toBe(1);
      });
      test("a closed pane is gone", async () => {
        const p = mk("gone");
        p.close();
        expect((await api.events(d, "gone", 0)).status).toBe(404);
      });
    });

    describe("history and reopen (WIRE.md 7.16)", () => {
      /** The program's own record: rows newest first, items per conversation, and the cursors it hands out. */
      const rows: ConversationRow[] = [];
      const stored = new Map<string, Item[]>();
      const listCalls: [string | undefined, number][] = [];
      const itemCalls: [string, string | undefined, number][] = [];
      const provider: HistoryProvider = {
        async list(after, limit) {
          listCalls.push([after, limit]);
          const from = after === undefined ? 0 : Number(after.slice(1));
          const page = rows.slice(from, from + limit);
          return from + limit < rows.length ? { items: page, next: `r${from + limit}` } : { items: page };
        },
        async items(id, after, limit) {
          itemCalls.push([id, after, limit]);
          const all = stored.get(id);
          if (all === undefined) return undefined;
          const from = after === undefined ? 0 : Number(after.slice(1));
          const page = all.slice(from, from + limit);
          return from + limit < all.length ? { items: page, next: `i${from + limit}` } : { items: page };
        },
      };
      const row = (id: string, state: "open" | "closed", extra: Partial<ConversationRow> = {}): ConversationRow => ({
        id,
        title: `T ${id}`,
        startedAt: "2026-10-13T09:00:00.000Z",
        state,
        items: stored.get(id)?.length ?? 0,
        ...extra,
      });
      const replyItems = (n: number, size = 10): Item[] =>
        Array.from({ length: n }, (_, i) => ({ id: `it-${i}`, ts: "2026-10-13T09:00:00.000Z", kind: "reply" as const, text: "x".repeat(size) }));

      test("history: both routes are 409 not-supported before the program sets a provider, and hello says history false", async () => {
        expect((await api.hello(d)).body.caps.history).toBe(false);
        expect([(await api.conversations(d)).status, (await api.conversations(d)).body.code]).toEqual([409, "not-supported"]);
        expect((await api.items(d, "p1")).body.code).toBe("not-supported");
        expect((await paneInfo("p1")).sessionId).toBeNull();
      });
      test("history: with a provider, hello says history true and every pane's sessionId is its pane id", async () => {
        stored.set("h-closed", replyItems(3));
        stored.set("p1", replyItems(1));
        rows.push(row("p1", "open"), row("h-closed", "closed", { subtitle: "  done \u0007 ", endedAt: "2026-10-13T10:00:00.000Z", workspaceId: "w", tabId: "w:t" }));
        collie.history(provider);
        expect((await api.hello(d)).body.caps.history).toBe(true);
        expect((await paneInfo("p1")).sessionId).toBe("p1");
        const own = collie.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("h-own", { title: "own", harness: "x", sessionId: "session-own" });
        expect((await paneInfo(own.id)).sessionId).toBe("session-own");
      });
      test("history: conversations lists the rows newest first, cleaned, open and closed, paged by the program's cursor", async () => {
        const r = await api.conversations(d);
        expect(r.status).toBe(200);
        expect(r.body.items.map((x) => [x.id, x.state, x.items])).toEqual([
          ["p1", "open", 1],
          ["h-closed", "closed", 3],
        ]);
        expect(r.body.items[1]).toMatchObject({ subtitle: "done", endedAt: "2026-10-13T10:00:00.000Z", workspaceId: "w", tabId: "w:t" });
        expect(r.body.next).toBeUndefined();
        const first = await api.conversations(d, { limit: 1 });
        expect([first.body.items.map((x) => x.id), first.body.next]).toEqual([["p1"], "r1"]);
        const second = await api.conversations(d, { after: first.body.next, limit: 1 });
        expect([second.body.items.map((x) => x.id), second.body.next]).toEqual([["h-closed"], undefined]);
        // The page is at most 100, whatever the caller asks for.
        await api.conversations(d, { limit: 5000 });
        expect(listCalls.at(-1)).toEqual([undefined, 100]);
      });
      test("history: a bad cursor or limit is 400 bad-cursor", async () => {
        for (const o of [{ after: "has space" }, { after: "x".repeat(513) }, { limit: 0 }, { limit: "two" }, { limit: -1 }]) {
          const r = await api.conversations(d, o);
          expect([JSON.stringify(o).slice(0, 30), r.status, r.body.code]).toEqual([JSON.stringify(o).slice(0, 30), 400, "bad-cursor"]);
        }
        expect((await api.items(d, "h-closed", { after: "a b" })).body.code).toBe("bad-cursor");
      });
      test("history: items of a closed conversation, oldest first, paged with more and next", async () => {
        const all = await api.items(d, "h-closed");
        expect([all.status, all.body.items.map((x) => x.id), all.body.more, all.body.next]).toEqual([200, ["it-0", "it-1", "it-2"], false, undefined]);
        const first = await api.items(d, "h-closed", { limit: 2 });
        expect([first.body.items.map((x) => x.id), first.body.more, first.body.next]).toEqual([["it-0", "it-1"], true, "i2"]);
        const rest = await api.items(d, "h-closed", { after: first.body.next, limit: 2 });
        expect([rest.body.items.map((x) => x.id), rest.body.more]).toEqual([["it-2"], false]);
        // An open conversation is served the same way.
        expect((await api.items(d, "p1")).body.items.map((x) => x.id)).toEqual(["it-0"]);
      });
      test("history: an unknown conversation, or an id that breaks the id rule, is 404 no-such-conversation", async () => {
        expect([(await api.items(d, "nobody")).status, (await api.items(d, "nobody")).body.code]).toEqual([404, "no-such-conversation"]);
        expect((await api.items(d, "a b")).body.code).toBe("no-such-conversation");
      });
      test("history: a page over 8 MiB asks the program again for the items that fit, and its cursor goes on from there", async () => {
        stored.set("h-big", replyItems(200, 60_000)); // 200 x 60 KB, about 12 MB
        const r = await api.items(d, "h-big");
        const kept = r.body.items.length;
        expect(kept).toBeGreaterThan(100);
        expect(kept).toBeLessThan(200);
        expect([r.body.more, r.body.next]).toEqual([true, `i${kept}`]);
        expect(itemCalls.slice(-2).map(([, , limit]) => limit)).toEqual([1000, kept]);
      });
      test("reopen: a pane closed in this process comes back with the same pane id, its items, and rev rose", async () => {
        const p = mk("h-re");
        p.event({ type: "item", item: { id: "re-1", kind: "reply", text: "before the close" } });
        expect((await api.close(d, "pane", "h-re")).body).toEqual({ ok: true });
        const before = (await api.snapshot(d)).body;
        expect(before.panes.some((x) => x.id === "h-re")).toBe(false);
        const r = await api.reopen(d, "h-re", "reopen-1");
        expect([r.status, r.body]).toEqual([200, { ok: true }]);
        const after = (await api.snapshot(d)).body;
        expect(after.panes.some((x) => x.id === "h-re")).toBe(true);
        expect(after.rev).toBeGreaterThan(before.rev);
        const events = (await api.events(d, "h-re", 0)).body.events;
        expect(events.some((e) => e.type === "item" && e.item.id === "re-1")).toBe(true);
        expect(reopenAsked.at(-1)).toEqual({ id: "h-re", paneId: "h-re", requestId: "reopen-1" });
        // A repeat answers from the receipt and runs nothing.
        const asked = reopenAsked.length;
        expect((await api.reopen(d, "h-re", "reopen-1")).body).toEqual({ ok: true, replayed: true });
        expect(reopenAsked.length).toBe(asked);
      });
      test("reopen: the hook shows a conversation closed before a restart; false is 422 reopen-refused and the id may run again", async () => {
        reopenVerdict = false;
        const refused = await api.reopen(d, "h-closed", "reopen-2");
        expect([refused.status, refused.body.code]).toEqual([422, "reopen-refused"]);
        expect((await api.snapshot(d)).body.panes.some((x) => x.id === "h-closed")).toBe(false);
        reopenVerdict = undefined;
        reopenShows = (id) => void collie.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane(id, { title: id, harness: "x" });
        try {
          expect((await api.reopen(d, "h-closed", "reopen-2")).body).toEqual({ ok: true });
        } finally {
          reopenShows = undefined;
        }
        expect(reopenAsked.at(-1)).toEqual({ id: "h-closed", requestId: "reopen-2" });
        expect((await api.snapshot(d)).body.panes.some((x) => x.id === "h-closed")).toBe(true);
      });
      test("reopen: a hook that shows nothing for a conversation this process never closed is 422 reopen-refused", async () => {
        stored.set("h-ghost", replyItems(1));
        const r = await api.reopen(d, "h-ghost");
        expect([r.status, r.body.code]).toEqual([422, "reopen-refused"]);
      });
      test("reopen: an unknown conversation is 404 no-such-target, an open one answers ok and changes nothing", async () => {
        expect((await api.reopen(d, "nobody")).body.code).toBe("no-such-target");
        const rev = (await api.snapshot(d)).body.rev;
        expect((await api.reopen(d, "p1")).body).toEqual({ ok: true });
        expect((await api.snapshot(d)).body.rev).toBe(rev);
      });
      test("reopen: a body without an id is 400, and the same request id for another conversation is request-id-reused", async () => {
        expect((await post("/reopen", { requestId: "reopen-x" })).body.code).toBe("bad-body");
        expect((await api.reopen(d, "nobody-else", "reopen-1")).body.code).toBe("request-id-reused");
      });
      test("reopen: with caps.reopen false it is 409 not-supported, and so is history with caps.history false", async () => {
        const off = await transport.open({ hostName: "off", caps: { ...ALL_CAPS, reopen: false, history: false } });
        off.collie.history(provider);
        off.collie.ready();
        try {
          expect((await api.hello(off.dial)).body.caps).toMatchObject({ reopen: false, history: false });
          expect((await api.reopen(off.dial, "p1")).body.code).toBe("not-supported");
          expect((await api.conversations(off.dial)).body.code).toBe("not-supported");
        } finally {
          await off.collie.close();
        }
      });
    });
    bunTest("every test the transport skips exists", () => {
      expect(Object.keys(transport.skip ?? {}).filter((title) => !titles.has(title))).toEqual([]);
    });
  });
}

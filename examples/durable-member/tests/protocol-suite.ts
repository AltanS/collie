// The protocol tests of the wire, written once and run twice: over the private socket (protocol.test.ts) and
// straight against the core's `handle(Request)` (core.test.ts), with no socket and no server. The two runs must
// agree, so the core is the wire and the socket is only its transport.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, call, type Dial } from "./client.ts";
import { type AskInput, type Caps, idOk, type PaneHandle, type Starter, type WorkspaceHandle } from "../sdk/core/index.ts";
import { cleanup, waitFor } from "./util.ts";

/** A program with no layout yet, and the dial that reaches it. */
export interface Opened {
  readonly epoch: string;
  workspace(id: string, o: { title: string; cwd?: string }): WorkspaceHandle;
  starters(list: Starter[]): void;
  ready(): void;
  close(): Promise<void>;
}
export interface Transport {
  name: string;
  open(o: { hostName: string; caps?: Partial<Caps> }): Promise<{ collie: Opened; dial: Dial }>;
}

export function protocolSuite(transport: Transport) {
  describe(transport.name, () => {
    let collie: Opened;
    let d: Dial;
    let pane: PaneHandle;
    const sent: [string, boolean, string][] = [];
    let aborted = 0;
    let starts = 0;
    const post = (path: string, body: unknown) => call(d, "POST", path, body);

    const options = [
      { id: "allow", label: "Allow", effect: "allow" as const },
      { id: "deny", label: "Deny", effect: "deny" as const },
    ];
    let n = 0;
    const askInput = (over: Partial<AskInput> = {}): AskInput => ({
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
      ({ collie, dial: d } = await transport.open({ hostName: "t" }));
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
        expect(r.body.caps).toEqual({ asks: true, starters: true, send: true, steer: true, abort: true, terminal: false });
      });
      test("409 incompatible with the range, never a 5xx; a header that is not an integer is the same", async () => {
        for (const version of [0, 2, 99]) {
          const r = await api.hello({ ...d, version });
          expect(r.status).toBe(409);
          expect(r.body as unknown).toEqual({ code: "incompatible", range: { min: 1, max: 1 } });
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
        expect((await call(d, "GET", "/pane/p1/answer")).status).toBe(404); // wrong method
        expect((await call(d, "DELETE", "/snapshot")).status).toBe(404);
        expect((await api.events(d, "nope", 0)).body.code).toBe("no-such-pane");
        expect((await api.start(d, "nope")).body.code).toBe("no-such-starter");
        expect((await call(d, "GET", "/what")).body.code).toBe("not-found");
      });
      test("a POST body over 64 KiB is 413 too-large, on every POST route", async () => {
        const pad = "x".repeat(70_000);
        for (const path of ["/pane/p1/answer", "/pane/p1/send", "/pane/p1/abort", "/starter/s1"]) {
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
      test("an ask carries toolCallId, revision, title and itemId; it sets waiting; answer resolves it by phone; a second answer is too-late", async () => {
        const p = mk("p3");
        const pending = p.ask(askInput({ toolCallId: "tc-1", itemId: "item-1", title: "Run it?" }));
        const info = await paneInfo("p3");
        expect(info.state).toBe("waiting");
        const ask = info.openAsks[0]!;
        expect(ask).toMatchObject({ kind: "permission", toolCallId: "tc-1", itemId: "item-1", title: "Run it?", revision: 1 });
        expect(ask.id).toMatch(/^[0-9a-f]{32}$/);
        expect((await api.answer(d, "p3", ask.id, "allow")).body).toEqual({ result: "taken" });
        expect(await pending).toEqual({ optionId: "allow" });
        expect((await api.answer(d, "p3", ask.id, "deny")).body).toEqual({ result: "too-late" });
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
      test("a closed or unknown ask is 200 too-late whatever the revision says, never an error", async () => {
        const p = mk("p3-late");
        hold(p, askInput({ id: "ask-late" }));
        await api.answer(d, "p3-late", "ask-late", "allow");
        for (const revision of [0, 1, 5]) {
          const r = await api.answer(d, "p3-late", "ask-late", "allow", { revision });
          expect([r.status, r.body]).toEqual([200, { result: "too-late" }]);
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
        const { collie: c, dial: t } = await transport.open({ hostName: "c", caps: { steer: false } });
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

        const { collie: none, dial: u } = await transport.open({ hostName: "c", caps: { send: false, abort: false, starters: false } });
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
  });
}

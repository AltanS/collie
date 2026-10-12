// The caps of WIRE.md section 6: the SDK cleans every display string and cuts it to its byte cap before it sends it.
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { api, type Dial } from "./client.ts";
import { CAPS, cut, openCollie, safeId, idOk } from "../sdk/index.ts";
import { cleanup, tmp } from "./util.ts";

afterAll(cleanup);
const B = (s: string) => Buffer.byteLength(s);

describe("caps: cleaning and cutting", () => {
  test("controls (C0, DEL, C1) go; newline and tab stay only in a multi-line field", () => {
    expect(cut("a\u0000b\u0007c\u001bd\u007fe\u0085f\u009fg", 100)).toBe("abcdefg");
    expect(cut("line\n\tindent\r", 100)).toBe("lineindent");
    expect(cut("line\n\tindent\r", 100, true)).toBe("line\n\tindent");
  });
  test("direction marks, overrides and isolates go", () => {
    expect(cut("a‎b‏c؜d‪e‫f‬g‭h‮i⁦j⁧k⁨l⁩m", 100)).toBe("abcdefghijklm");
  });
  test("a string over the cap is cut at a whole code point with room for the 3-byte ellipsis", () => {
    const x = cut("x".repeat(500), 128);
    expect(B(x)).toBe(128);
    expect(x.endsWith("…")).toBe(true);
    const e = cut("é".repeat(500), 128); // 2 bytes each: 62 fit in 125 bytes, then the ellipsis
    expect(e).toBe(`${"é".repeat(62)}…`);
    expect(B(e)).toBeLessThanOrEqual(128);
    const emoji = cut("😀".repeat(100), 64); // 4 bytes each: 15 fit in 61 bytes
    expect(emoji).toBe(`${"😀".repeat(15)}…`);
    expect(emoji).not.toContain("�");
    expect(cut("short", 128)).toBe("short");
    expect(cut("x".repeat(128), 128)).toBe("x".repeat(128)); // exactly at the cap: untouched
  });
  test("safeId maps a model's odd id to a valid one, the same every time, and leaves a valid one alone", () => {
    expect(safeId("toolu_01A")).toBe("toolu_01A");
    for (const raw of ["call/1", "call 1", "a?b#c", "x".repeat(300), "", "é".repeat(100), "tab\tid"]) {
      const id = safeId(raw);
      expect([raw.length, idOk(id)]).toEqual([raw.length, true]);
      expect(safeId(raw)).toBe(id);
    }
    expect(safeId("a/b")).not.toBe(safeId("a b"));
  });
});

describe("caps: every field over the wire", () => {
  const dirty = (s: string, n = 6000) => `\u0000${s}‮${"é".repeat(n)}`;

  test("host name, titles, harness, labels, reason, tool fields, item text and settled reason are cut in bytes", async () => {
    const c = await openCollie({ callerCheck: "off", socket: join(tmp(), "c.sock"), hostName: dirty("host") });
    const d: Dial = { socket: c.address, version: 1 };
    const ws = c.workspace("w", { title: dirty("ws"), cwd: "/srv/ok" });
    const p = ws.tab("t", { title: dirty("tab") }).pane("p", { title: dirty("pane"), harness: dirty("pi") });
    c.starters([{ id: "s", label: dirty("starter"), run: async () => ({ paneId: "p" }) }]);
    c.ready();

    p.event({ type: "item", item: { id: "u", kind: "user", text: `${dirty("text", 40_000)}\nsecond line` } });
    p.event({ type: "item", item: { id: "t1", ts: "2026-10-12T09:30:00.000Z", kind: "tool", status: "done", tool: { kind: "other", name: dirty("name"), summary: dirty("sum"), output: dirty("out", 20_000) } } });
    p.event({ type: "settled", inputId: "i1", requestId: "r1", status: "unanswered", reason: dirty("aborted") });
    const pending = p.ask({
      kind: "permission",
      toolCallId: "tc",
      itemId: "t1",
      title: dirty("ask title"),
      reason: `line one\n${dirty("reason", 3000)}`,
      tool: { kind: "other", name: dirty("n"), summary: dirty("s"), output: dirty("o", 20_000) },
      options: Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, label: dirty("label"), effect: "allow" as const })),
    });
    pending.catch(() => {});

    const hello = (await api.hello(d)).body;
    expect(B(hello.host.name)).toBeLessThanOrEqual(CAPS.hostName);
    const snap = (await api.snapshot(d)).body;
    expect(B(snap.workspaces[0]!.title)).toBeLessThanOrEqual(CAPS.title);
    expect(snap.workspaces[0]!.cwd).toBe("/srv/ok");
    expect(B(snap.tabs[0]!.title)).toBeLessThanOrEqual(CAPS.title);
    const pane = snap.panes[0]!;
    expect(B(pane.title)).toBeLessThanOrEqual(CAPS.title);
    expect(B(pane.harness)).toBeLessThanOrEqual(CAPS.harness);
    expect(B(snap.starters![0]!.label)).toBeLessThanOrEqual(CAPS.starterLabel);
    const ask = pane.openAsks[0]!;
    expect(B(ask.title)).toBeLessThanOrEqual(CAPS.askTitle);
    expect(B(ask.reason!)).toBeLessThanOrEqual(CAPS.reason);
    expect(ask.reason).toContain("\n"); // a multi-line field keeps its newline
    expect(ask.options).toHaveLength(6); // the first 6
    expect(ask.options.every((o) => B(o.label) <= CAPS.optionLabel)).toBe(true);
    expect(B(ask.tool!.name)).toBeLessThanOrEqual(CAPS.toolName);
    expect(B(ask.tool!.summary)).toBeLessThanOrEqual(CAPS.summary);
    expect(B(ask.tool!.output!)).toBeLessThanOrEqual(CAPS.output);

    const events = (await api.events(d, "p", 0)).body.events;
    const user = events.flatMap((e) => (e.type === "item" && e.item.kind === "user" ? [e.item] : []))[0]!;
    expect(B(user.text)).toBeLessThanOrEqual(CAPS.text);
    const tool = events.flatMap((e) => (e.type === "item" && e.item.kind === "tool" ? [e.item] : []))[0]!;
    expect(B(tool.tool.name)).toBeLessThanOrEqual(CAPS.toolName);
    expect(B(tool.tool.summary)).toBeLessThanOrEqual(CAPS.summary);
    expect(B(tool.tool.output!)).toBeLessThanOrEqual(CAPS.output);
    expect(tool.ts).toBe("2026-10-12T09:30:00.000Z");
    const settled = events.find((e) => e.type === "settled")!;
    expect(B((settled as { reason: string }).reason)).toBeLessThanOrEqual(CAPS.settledReason);

    // nothing on the wire holds a control character or a direction mark
    const wire = JSON.stringify([hello, snap]);
    expect(wire).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/);
    await c.close();
  });

  test("single-line fields lose their newline; a cwd that is relative, too long or holds a control reads as absent; a bad ts is dropped", async () => {
    const c = await openCollie({ callerCheck: "off", socket: join(tmp(), "d.sock"), hostName: "h" });
    const d: Dial = { socket: c.address, version: 1 };
    const tab = c.workspace("w", { title: "line\none", cwd: "relative/path" }).tab("t", { title: "T" });
    tab.pane("long", { title: "ok", harness: "x", cwd: `/${"d".repeat(CAPS.cwd)}` });
    tab.pane("ctl", { title: "ok", harness: "x", cwd: "/srv/\u0007bell" });
    const p = tab.pane("good", { title: "ok", harness: "x", cwd: `/${"d".repeat(CAPS.cwd - 1)}` });
    c.ready();
    p.event({ type: "item", item: { id: "a", ts: "yesterday", kind: "reply", text: "x" } });
    p.event({ type: "item", item: { id: "b", ts: "2026-10-12T09:30:00+02:00", kind: "reply", text: "x" } });
    p.event({ type: "item", item: { id: "c", ts: `2026-10-12T09:30:00.${"0".repeat(40)}Z`, kind: "reply", text: "x" } });
    const s = (await api.snapshot(d)).body;
    expect(s.workspaces[0]).toEqual({ id: "w", title: "lineone" });
    const byId = new Map(s.panes.map((x) => [x.id, x]));
    expect("cwd" in byId.get("long")!).toBe(false); // 4097 bytes
    expect("cwd" in byId.get("ctl")!).toBe(false);
    expect(B(byId.get("good")!.cwd!)).toBe(CAPS.cwd); // exactly 4096 bytes stays
    const items = (await api.events(d, "good", 0)).body.events.flatMap((e) => (e.type === "item" ? [e.item] : []));
    expect(items.map((i) => i.ts)).toEqual([undefined, "2026-10-12T09:30:00+02:00", undefined]);
    await c.close();
  });

  test("a send of 32768 bytes is the most the program takes, and an error message is cut to 512 bytes", async () => {
    const c = await openCollie({ callerCheck: "off", socket: join(tmp(), "e.sock"), hostName: "h" });
    const d: Dial = { socket: c.address, version: 1 };
    c.starters([{ id: "s", label: "S", run: async () => Promise.reject(new Error("é".repeat(1000))) }]);
    c.ready();
    const r = await api.start(d, "s");
    expect(r.status).toBe(422);
    expect(B(r.body.message!)).toBeLessThanOrEqual(CAPS.message);
    expect(CAPS.sendText).toBe(32768);
    await c.close();
  });
});

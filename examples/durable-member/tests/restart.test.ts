// A restart for real: app.ts as a child process on real JSONL storage, killed with SIGKILL while an
// ask is open, then started again on the same storage and socket.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PaneRegistry } from "../pi-durable/index.ts";
import { askIdFor, createCore } from "../sdk/core/index.ts";
import { api, type Dial } from "./client.ts";
import { allEvents, bootApp, type Child, cleanup, firstAsk, killApp, pane, tmp, waitFor } from "./util.ts";

const dir = tmp();
const d: Dial = { socket: join(dir, "s.sock"), version: 1 };
let child: Child | undefined;

const boot = async () => void (child = await bootApp(d, dir, { DM_SLOW_MS: "300" }));
async function kill(signal: "SIGKILL" | "SIGTERM") {
  await killApp(child!, signal);
}
afterAll(async () => {
  if (child && child.exitCode === null) await kill("SIGKILL");
  cleanup();
});

describe("restart with an open ask", () => {
  let main = "";
  let oldAsk = "";
  let oldToolCall = "";
  let oldEpoch = "";
  let oldNext = 0;

  test("a first start opens one ticket, and it waits on an ask", async () => {
    await boot();
    const panes = (await api.snapshot(d)).body.panes;
    expect(panes.map((x) => x.tabId)).toEqual(["triage:inbox"]);
    main = panes[0]!.id;
    const p = await waitFor("ask", () => firstAsk(d, main));
    oldAsk = p.id;
    oldToolCall = p.toolCallId;
    const snap = (await api.snapshot(d)).body;
    oldEpoch = snap.epoch;
    oldNext = (await api.events(d, main, 0)).body.next;
    expect(snap.panes.find((x) => x.id === main)!.state).toBe("waiting");
  });

  test("SIGKILL, start again: same pane id, same history, new epoch", async () => {
    await kill("SIGKILL");
    await boot();
    const snap = (await api.snapshot(d)).body;
    expect(snap.epoch).not.toBe(oldEpoch);
    const p = snap.panes.find((x) => x.id === main)!;
    expect(p).toMatchObject({ title: expect.stringContaining("Ticket"), tabId: "triage:inbox" });
    const events = await allEvents(d, main);
    expect(events.some((e) => e.type === "item" && e.item.kind === "user")).toBe(true);
    expect(events.some((e) => e.type === "item" && e.item.kind === "tool" && e.item.tool.name === "write_note")).toBe(true);
    expect(events.some((e) => e.type === "synced")).toBe(true);
  });

  test("after the wake the open ask has the same id: Pi re-runs the hook before the app is ready", async () => {
    // No wait: the first snapshot the restarted app serves carries the ask, by contract (WIRE.md 8.2).
    const p = (await pane(d, main))!.openAsks[0]!;
    expect(p.id).toBe(oldAsk); // derived from the pane and the tool call, so the same across the restart
    // The tool call id is stored in the transcript, so it survives the kill. The bridge keys its push
    // guard on it, so the same question is shown again but not pushed twice.
    expect(p.toolCallId).toBe(oldToolCall);
    expect(p.itemId).toBe(oldToolCall);
    expect(p.revision).toBe(1); // starts at 1 again
    expect((await pane(d, main))!.state).toBe("waiting");
    // the old cursor means nothing after a restart: the server says so and sends the whole log
    const stale = (await api.events(d, main, oldNext, oldEpoch)).body;
    expect(stale.reset).toBe(true);
  });

  test("an answer to the id listed before the restart lands: taken, and the tool ran once (same id)", async () => {
    expect((await api.answer(d, main, oldAsk, "allow", { revision: 1 })).body).toEqual({ result: "taken" });
    await waitFor("idle", async () => (await pane(d, main))?.state === "idle");
    const helper = (await api.snapshot(d)).body.panes.find((x) => x.tabId === "triage:helpers");
    expect(helper).toBeTruthy();
    const lines = readFileSync(join(dir, "notes.txt"), "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  test("a second restart with nothing open: both panes come back idle with their history, and no new ticket", async () => {
    await kill("SIGKILL");
    await boot();
    const snap = (await api.snapshot(d)).body;
    expect(snap.panes.map((x) => [x.tabId, x.state]).sort()).toEqual([["triage:helpers", "idle"], ["triage:inbox", "idle"]]);
    const events = await allEvents(d, main);
    expect(events.filter((e) => e.type === "item" && e.item.kind === "reply").length).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "state", state: "idle" });
    expect(events.at(-2)).toMatchObject({ type: "synced" });
  });

  test("a polite SIGTERM with an open ask is no answer: nothing is denied, the ask comes back after the restart with the same id", async () => {
    const id = (await api.start(d, "new-triage")).body.paneId;
    const first = await waitFor("ask", () => firstAsk(d, id));
    const t0 = Date.now();
    await kill("SIGTERM");
    expect(Date.now() - t0).toBeLessThan(4000); // it left, although a hook still waited for the phone
    await boot();
    const events = await allEvents(d, id);
    const statuses = events.flatMap((e) => (e.type === "item" && e.item.kind === "tool" ? [e.item.status] : []));
    expect(statuses).toEqual(["running"]); // no "denied": shutdown did not decide for the human
    const again = await waitFor("ask again", () => firstAsk(d, id));
    expect(again.id).toBe(first.id); // the same id after the restart
  });

  test("requestId goes to Pi Durable: after a restart the program's own memory is gone, and Pi still admits the input once", async () => {
    const users = async (text: string) => (await allEvents(d, main)).filter((e) => e.type === "item" && e.item.kind === "user" && e.item.text === text).length;
    const turnId = (await pane(d, main))!.turnId;
    expect((await api.send(d, main, "ping", { turnId, requestId: "pi-dedupe" })).body).toEqual({ ok: true });
    await waitFor("answered", async () => (await users("ping")) === 1 && (await pane(d, main))?.state === "idle");
    await kill("SIGKILL");
    await boot();
    const again = await api.send(d, main, "ping", { requestId: "pi-dedupe" }); // a fresh epoch: not a wire replay
    expect([again.status, again.body]).toEqual([200, { ok: true }]);
    await new Promise((r) => setTimeout(r, 800)); // a second run would have started and finished by now
    expect(await users("ping")).toBe(1);
    expect((await pane(d, main))!.state).toBe("idle");
    // a different request id with the same text is a new input
    expect((await api.send(d, main, "ping", { requestId: "pi-dedupe-2" })).status).toBe(200);
    await waitFor("second ping", async () => (await users("ping")) === 2);
  });
});

describe("the re-raise window (the start path of app.ts and of the Cloudflare member)", () => {
  test("a waiting call whose hook does not run again: the start goes on after the window and logs once; a late raise keeps its id", async () => {
    const core = createCore({ hostName: "wake" });
    const p = core.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p", { title: "P", harness: "pi" });
    const panes = new PaneRegistry();
    panes.toolStatus("call-1", "write_note", "running"); // replayed from storage before resume(), no result yet
    const logs: string[] = [];
    await panes.reRaised(new Set(["write_note"]), 50, (line) => logs.push(line));
    core.ready();
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("call-1");
    const late = (await api.snapshot({ handler: (r: Request) => core.handle(r), version: 1 })).body.panes[0]!;
    expect(late.openAsks).toEqual([]);
    void p.ask({ kind: "permission", toolCallId: "call-1", itemId: "call-1", title: "write_note", options: [{ id: "allow", label: "Allow", effect: "allow" }] });
    panes.asked("call-1"); // after the window: nothing waits for it any more, and nothing throws
    const listed = (await api.snapshot({ handler: (r: Request) => core.handle(r), version: 1 })).body.panes[0]!;
    expect(listed.openAsks.map((a) => a.id)).toEqual([askIdFor("p", "call-1")]);
    expect(logs.length).toBe(1);
  });
});

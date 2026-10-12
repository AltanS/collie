// A restart for real: app.ts as a child process on real JSONL storage, killed with SIGKILL while an
// ask is open, then started again on the same storage and socket.
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
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

  test("the open ask: Pi re-runs the hook, so the pane asks again with a NEW id; the old id is too-late", async () => {
    const p = await waitFor("a new ask", () => firstAsk(d, main));
    expect(p.id).not.toBe(oldAsk);
    // The tool call id is stored in the transcript, so it survives the kill. The bridge keys its push
    // guard on it, so the same question is shown again but not pushed twice.
    expect(p.toolCallId).toBeTruthy();
    expect(p.toolCallId).toBe(oldToolCall);
    expect(p.itemId).toBe(oldToolCall);
    expect(p.revision).toBe(1); // starts at 1 again
    expect((await pane(d, main))!.state).toBe("waiting");
    expect((await api.answer(d, main, oldAsk, "allow")).body).toEqual({ result: "too-late" });
    // the old cursor means nothing after a restart: the server says so and sends the whole log
    const stale = (await api.events(d, main, oldNext, oldEpoch)).body;
    expect(stale.reset).toBe(true);
  });

  test("the new ask works: allow, and the run finishes with its helper pane", async () => {
    const open = (await pane(d, main))!.openAsks[0]!;
    expect((await api.answer(d, main, open.id, "allow")).body).toEqual({ result: "taken" });
    await waitFor("idle", async () => (await pane(d, main))?.state === "idle");
    const helper = (await api.snapshot(d)).body.panes.find((x) => x.tabId === "triage:helpers");
    expect(helper).toBeTruthy();
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

  test("a polite SIGTERM with an open ask is no answer: nothing is denied, the ask comes back after the restart", async () => {
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
    expect(again.id).not.toBe(first.id);
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

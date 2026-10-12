// A SIGKILL while a helper is mid-answer. The helper's faux answer takes 3 s (DM_HELPER_MS), so the kill
// lands while its model request is in flight. What the test pins is what the run did, observed on Pi Durable 1.0.2.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { api, type Dial } from "./client.ts";
import { allEvents, bootApp, type Child, cleanup, firstAsk, killApp, pane, tmp, waitFor } from "./util.ts";

const HELPER_MS = 3000;
const dir = tmp();
const d: Dial = { socket: join(dir, "s.sock"), version: 1 };
let child: Child | undefined;
afterAll(async () => {
  if (child && child.exitCode === null) await killApp(child);
  cleanup();
});

const helperPanes = async () => (await api.snapshot(d)).body.panes.filter((p) => p.tabId === "triage:helpers");
const count = (events: Awaited<ReturnType<typeof allEvents>>, kind: string) => events.filter((e) => e.type === "item" && e.item.kind === kind).length;

describe("kill while the helper answers", () => {
  let main = "";
  let helper = "";

  test("before the kill: the helper pane works on its task", async () => {
    child = await bootApp(d, dir, { DM_HELPER_MS: String(HELPER_MS) });
    main = (await api.snapshot(d)).body.panes[0]!.id; // the ticket a first start opens
    await api.answer(d, main, (await waitFor("ask", () => firstAsk(d, main))).id, "allow");
    const h = await waitFor("helper working", async () => (await helperPanes()).find((p) => p.state === "working"));
    helper = h.id;
    expect(count(await allEvents(d, helper), "reply")).toBe(0);
  });

  test("after SIGKILL and a restart: the same helper pane, one helper, both panes still working", async () => {
    await killApp(child!);
    const t0 = Date.now();
    child = await bootApp(d, dir, { DM_HELPER_MS: String(HELPER_MS) });
    const panes = await helperPanes();
    expect(panes.map((p) => p.id)).toEqual([helper]); // same id, and no second child
    expect(panes[0]!.state).toBe("working");
    expect((await pane(d, main))!.state).toBe("working");
    expect(count(await allEvents(d, helper), "user")).toBe(1); // the task is in the history once

    // The helper does not resume mid-answer. Its model request starts over and takes the full 3 s again.
    await waitFor("main idle", async () => (await pane(d, main))?.state === "idle", 15_000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(HELPER_MS - 500);
  });

  test("the result: one helper answer, one final reply, one note, one helper pane", async () => {
    const helperEvents = await allEvents(d, helper);
    expect(count(helperEvents, "user")).toBe(1);
    expect(count(helperEvents, "reply")).toBe(1);
    expect((await pane(d, helper))!.state).toBe("idle");
    expect((await helperPanes()).length).toBe(1);

    const mainEvents = await allEvents(d, main);
    const spawns = mainEvents.flatMap((e) => (e.type === "item" && e.item.kind === "tool" && e.item.tool.name === "spawn_helper" ? [e.item.status] : []));
    expect(spawns).toEqual(["running", "done"]); // one call, running then done: the parent got the answer once
    const replies = mainEvents.flatMap((e) => (e.type === "item" && e.item.kind === "reply" ? [e.item.text] : []));
    expect(replies).toEqual(["Triage done. The helper says: Probably an expired session cookie after the password reset."]);
    expect(mainEvents.filter((e) => e.type === "state").at(-1)).toMatchObject({ state: "idle" });
    expect(mainEvents.at(-1)).toMatchObject({ type: "settled", status: "answered" }); // the input settles after the run ends
    expect(readFileSync(join(dir, "notes.txt"), "utf8").trim().split("\n")).toHaveLength(1); // write_note ran once
  });
});

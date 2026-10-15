// Every question the support desk raises expires (WIRE.md 7.3, M55 spec 14): the ask carries `expiresAt`, ten minutes ahead
// by default, and an ask nobody answered in time is decided by `timeout`. The app treats that as a deny, logs it as its own
// line, and goes on. `DM_ASK_TIMEOUT_MS` changes the window, so a test or a demo can shorten it.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { type App, DEFAULT_ASK_TIMEOUT_MS, optionsFromEnv, startApp } from "../app.ts";
import { api, type Dial } from "./client.ts";
import { allEvents, cleanup, firstAsk, openAsks, pane, tmp, waitFor } from "./util.ts";

afterAll(cleanup);

const apps: App[] = [];
async function boot(askTimeoutMs?: number): Promise<{ app: App; d: Dial; dir: string }> {
  const dir = tmp();
  const app = await startApp({ socket: join(dir, "s.sock"), storage: "memory", stepMs: 0, notesFile: join(dir, "notes.txt"), callerCheck: "off", seed: false, askTimeoutMs });
  apps.push(app);
  return { app, d: { socket: app.collie.address, version: 1 }, dir };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

let log: ReturnType<typeof spyOn>;
beforeEach(() => {
  log = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => log.mockRestore());
const logged = () => log.mock.calls.map((c: unknown[]) => c.join(" ")).filter((l: string) => l.startsWith("durable-member:"));

/** The wait a stamp leaves from now, in milliseconds. */
const ahead = (stamp: string | undefined) => Date.parse(stamp!) - Date.now();

describe("DM_ASK_TIMEOUT_MS", () => {
  test("the default is ten minutes, and the variable changes it", () => {
    expect(DEFAULT_ASK_TIMEOUT_MS).toBe(10 * 60_000);
    expect(optionsFromEnv({}).askTimeoutMs).toBeUndefined();
    expect(optionsFromEnv({ DM_ASK_TIMEOUT_MS: "50" }).askTimeoutMs).toBe(50);
    expect(() => optionsFromEnv({ DM_ASK_TIMEOUT_MS: "soon" })).toThrow("DM_ASK_TIMEOUT_MS must be a whole number of milliseconds");
  });
});

describe("the desk's questions expire", () => {
  test("by default every ask carries an expiresAt about ten minutes ahead, the note's and the two questions'", async () => {
    const { d } = await boot();
    const id = (await api.start(d, "double-charge")).body.paneId;
    const note = await waitFor("the note's ask", () => firstAsk(d, id));
    expect(note.kind).toBe("permission");
    expect(Math.abs(ahead(note.expiresAt) - 10 * 60_000)).toBeLessThan(5000);
    expect((await api.answer(d, id, note.id, "allow")).body).toEqual({ result: "taken" });

    const choice = await waitFor("the choice", async () => (await openAsks(d, id)).find((a) => a.kind === "choice"));
    expect(Math.abs(ahead(choice.expiresAt) - 10 * 60_000)).toBeLessThan(5000);
    expect((await api.answerWith(d, id, choice.id, { optionIds: ["billing"] })).body).toEqual({ result: "taken" });

    const text = await waitFor("the line", async () => (await openAsks(d, id)).find((a) => a.kind === "text"));
    expect(Math.abs(ahead(text.expiresAt) - 10 * 60_000)).toBeLessThan(5000);
    // Answer the line, so no tool still waits on it when the app closes.
    expect((await api.answerWith(d, id, text.id, { text: "On it." })).body).toEqual({ result: "taken" });
    await waitFor("idle", async () => (await pane(d, id))?.state === "idle");
  });

  test("a short timeout ends the note's ask as a timeout: the tool is denied, the app logs it, the run goes on", async () => {
    const { d, dir } = await boot(50);
    const id = (await api.start(d, "sign-in")).body.paneId;
    const events = await waitFor("the timeout", async () => {
      const all = await allEvents(d, id);
      return all.some((e) => e.type === "ask-closed") ? all : undefined;
    });
    expect(events.find((e) => e.type === "ask-closed")).toMatchObject({ by: "stopped", decidedBy: "timeout" });
    await waitFor("idle", async () => (await pane(d, id))?.state === "idle");
    // The tool never ran: denied, no note on disk, and the scripted model says it stopped. No crash, no second ask.
    const after = await allEvents(d, id);
    expect(after.some((e) => e.type === "item" && e.item.kind === "tool" && e.item.status === "denied")).toBe(true);
    expect(after.filter((e) => e.type === "ask")).toHaveLength(1);
    expect(await openAsks(d, id)).toEqual([]);
    expect(await Bun.file(join(dir, "notes.txt")).exists()).toBe(false);
    expect(logged()).toEqual(["durable-member: write_note denied: timed out (Save this note to the ticket?)"]);
  });

  test("a question the person never answers ends the same way: an error result, a log line, and the run goes on", async () => {
    const { d } = await boot(1500);
    const id = (await api.start(d, "double-charge")).body.paneId;
    const note = await waitFor("the note's ask", () => firstAsk(d, id));
    await api.answer(d, id, note.id, "allow");
    const choice = await waitFor("the choice", async () => (await openAsks(d, id)).find((a) => a.kind === "choice"));
    // Nobody answers it. The clock closes it, and a late tap is refused as decided.
    await waitFor("the choice closes", async () => (await allEvents(d, id)).some((e) => e.type === "ask-closed" && (e as any).askId === choice.id), 6000);
    const late = await api.answerWith(d, id, choice.id, { optionIds: ["billing"] });
    expect([late.status, late.body.code]).toEqual([409, "decided"]);
    await waitFor("idle", async () => (await pane(d, id))?.state === "idle");
    const events = await allEvents(d, id);
    expect(events.filter((e) => e.type === "item" && e.item.kind === "reply").at(-1)).toMatchObject({ item: { text: "Nobody answered in time, so I stopped here." } });
    expect(events.filter((e) => e.type === "ask")).toHaveLength(2); // the note and the choice: no retry, no text ask
    expect(logged()).toContain("durable-member: ask_queue denied: timed out (Which team should take this?)");
  });
});

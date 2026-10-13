// A reply that grows (WIRE.md 7.15), through the real app: the scripted model writes its long answer in chunks, the
// pane writes the reply again under one id as it grows, and a stop cuts it where it is. Also the Mapper alone, with
// events as Pi Durable delivers them and a clock the test moves.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startApp, type App } from "../app.ts";
import { PaneRegistry, Mapper, PARTIAL_MS } from "../pi-durable/index.ts";
import { LONG_ANSWER_START, longAnswer } from "../script.ts";
import type { AgentEvent, MessageChange, SnapshotEvent } from "@earendil-works/pi-durable";
import { api, type Dial } from "./client.ts";
import type { Item, ProgramEvent } from "../../../packages/durable-sdk/src/core/types.ts";
import { allEvents, cleanup, firstAsk, latestItems, pane, tmp, waitFor } from "./util.ts";

const SLOW_MS = 4000;
let app: App;
let d: Dial;
let main = "";

beforeAll(async () => {
  const dir = tmp();
  app = await startApp({ socket: join(dir, "s.sock"), storage: "memory", stepMs: 0, slowMs: SLOW_MS, notesFile: join(dir, "notes.txt"), callerCheck: "off", seed: false });
  d = { socket: app.collie.address, version: 1 };
  main = (await api.start(d, "sign-in")).body.paneId;
  await api.answer(d, main, (await waitFor("ask", () => firstAsk(d, main))).id, "allow");
  await waitFor("idle", async () => (await pane(d, main))?.state === "idle");
});
afterAll(async () => {
  await app.close();
  cleanup();
});

type Reply = Extract<Item, { kind: "reply" | "thinking" | "notice" }>;
const repliesOf = (events: Awaited<ReturnType<typeof allEvents>>, id?: string): Reply[] =>
  events.flatMap((e) => (e.type === "item" && e.item.kind === "reply" && (id === undefined || e.item.id === id) ? [e.item] : []));

describe("a reply that grows, through the app", () => {
  test("the follow-up is written again and again under one id, partial until the last version", async () => {
    const before = (await api.events(d, main, 0)).body.next;
    const sent = await api.send(d, main, "one more thing", { requestId: "stream-send-1" });
    expect(sent.body).toEqual({ ok: true });
    await waitFor("idle again", async () => (await pane(d, main))?.state === "idle" && (await allEvents(d, main)).length > before + 6, SLOW_MS * 3);
    const fresh = (await allEvents(d, main)).slice(before);
    const longs = repliesOf(fresh).filter((r) => r.text.startsWith(LONG_ANSWER_START));
    const id = longs[0]!.id;
    const versions = repliesOf(fresh, id);
    // Several versions under ONE id, partial all but the last, the text only ever growing.
    expect(versions.length).toBeGreaterThan(3);
    expect(new Set(longs.map((r) => r.id)).size).toBe(1);
    expect(versions.slice(0, -1).every((r) => r.partial === true)).toBe(true);
    expect(versions.at(-1)).not.toHaveProperty("partial");
    expect(versions.at(-1)!.text).toBe(longAnswer(SLOW_MS));
    for (let i = 1; i < versions.length; i++) expect(versions[i]!.text.startsWith(versions[i - 1]!.text)).toBe(true);
    // A reader holds one reply, not one per version.
    expect(latestItems(fresh).filter((item) => item.kind === "reply" && item.text.startsWith(LONG_ANSWER_START))).toHaveLength(1);
    // No version is written faster than the least gap, give or take the scheduler: the count stays far below one per chunk.
    expect(versions.length).toBeLessThan((SLOW_MS / PARTIAL_MS) * 2);
  });

  test("the user line carries the request id of the send that made it", async () => {
    const items = latestItems(await allEvents(d, main));
    const mine = items.find((item) => item.kind === "user" && item.text === "one more thing");
    expect(mine).toMatchObject({ kind: "user", requestId: "stream-send-1" });
  });

  test("a stop cuts the reply where it is: the last version has no partial, and nothing follows it", async () => {
    const before = (await api.events(d, main, 0)).body.next;
    await api.send(d, main, "and another", { requestId: "stream-send-2" });
    const growing = await waitFor("a partial reply", async () => {
      const here = (await allEvents(d, main)).slice(before);
      const partials = repliesOf(here).filter((r) => r.partial === true && r.text.startsWith(LONG_ANSWER_START));
      return partials.length >= 2 ? partials.at(-1) : undefined;
    }, SLOW_MS);
    expect((await api.abort(d, main)).status).toBe(200);
    await waitFor("idle after stop", async () => (await pane(d, main))?.state === "idle");
    const settled = (await allEvents(d, main)).slice(before);
    const versions = repliesOf(settled, growing.id);
    const last = versions.at(-1)!;
    expect(last).not.toHaveProperty("partial"); // the cursor goes away
    expect(last.text.length).toBeGreaterThanOrEqual(growing.text.length);
    expect(last.text.length).toBeLessThan(longAnswer(SLOW_MS).length); // cut, not finished
    expect(longAnswer(SLOW_MS).startsWith(last.text)).toBe(true);
    // Quiet afterwards: no further version of it, and no item is left growing.
    const count = (await allEvents(d, main)).length;
    await new Promise((r) => setTimeout(r, PARTIAL_MS * 3));
    expect((await allEvents(d, main)).length).toBe(count);
    expect(latestItems(settled).some((item) => "partial" in item && item.partial === true)).toBe(false);
  });
});

// ── the Mapper alone ─────────────────────────────────────────────────────────

const T0 = 1_791_000_000_000;
const usage = {} as never;

function fakePane() {
  const events: ProgramEvent[] = [];
  const states: string[] = [];
  const handle = {
    event: (e: ProgramEvent) => void events.push(e),
    state: (s: string) => void states.push(s),
    progress: () => undefined,
  };
  const items = () => events.flatMap((e) => (e.type === "item" ? [e.item] : []));
  return { handle, events, items, states };
}

function mapperWith(clock: { now: number }) {
  const p = fakePane();
  // SAFETY: the Mapper uses `event`, `state` and `progress` of the pane and nothing else.
  const mapper = new Mapper(p.handle as never, new PaneRegistry(), false, () => clock.now);
  return { mapper, ...p };
}

const start = (text: string): AgentEvent => ({ type: "message_start", message: { role: "assistant", timestamp: T0, content: [{ type: "text", text }] } as never });
const grow = (delta: string): AgentEvent => ({ type: "message_update", usage, changes: [{ type: "text_delta", contentIndex: 0, delta } satisfies MessageChange] });
const finished = (text: string, entryId = 7): AgentEvent => ({
  type: "message_end",
  entry: { id: entryId, conversationId: 1, kind: "message", model: [{ role: "assistant", timestamp: T0, stopReason: "stop", content: [{ type: "text", text }] }] } as never,
});

describe("the Mapper", () => {
  test("a growing text is written at most every PARTIAL_MS, and the end writes the final version under the same id", () => {
    const clock = { now: 1000 };
    const m = mapperWith(clock);
    m.mapper.applyAll([start("He")]);
    m.mapper.applyAll([grow("llo")]); // first write at once
    clock.now += 100;
    m.mapper.applyAll([grow(", wor")]); // too soon: held
    clock.now += PARTIAL_MS;
    m.mapper.applyAll([grow("ld")]);
    m.mapper.applyAll([finished("Hello, world")]);
    const items = m.items();
    expect(items.map((i) => i.kind === "reply" && [i.text, i.partial === true])).toEqual([
      ["Hello", true],
      ["Hello, world", true],
      ["Hello, world", false],
    ]);
    expect(new Set(items.map((i) => i.id)).size).toBe(1); // ONE id: the finished message is named like its partials
  });

  test("a message that is whole when it starts writes one item, no partial", () => {
    const m = mapperWith({ now: 1 });
    m.mapper.applyAll([start("All of it"), finished("All of it")]);
    expect(m.items()).toHaveLength(1);
    expect(m.items()[0]).not.toHaveProperty("partial");
  });

  test("a run that ends with no entry for what was written finishes it, without partial", () => {
    const m = mapperWith({ now: 1000 });
    m.mapper.applyAll([start("Part"), grow("ial text")]);
    expect(m.items().at(-1)).toMatchObject({ text: "Partial text", partial: true });
    m.mapper.applyAll([{ type: "run_end", inputs: [] }]);
    const last = m.items().at(-1)!;
    expect(last).toMatchObject({ kind: "reply", text: "Partial text" });
    expect(last).not.toHaveProperty("partial");
    expect(m.states.at(-1)).toBe("idle");
  });

  test("an empty or blank text writes nothing yet", () => {
    const m = mapperWith({ now: 1000 });
    m.mapper.applyAll([start(""), grow("  ")]);
    expect(m.items()).toHaveLength(0);
  });

  test("a snapshot forgets the answer in flight, so nothing is finished twice", () => {
    const m = mapperWith({ now: 1000 });
    m.mapper.applyAll([start("Part"), grow("ial")]);
    const written = m.items().length;
    m.mapper.applyAll([{ type: "snapshot", entries: [], tools: [], compactions: [], inbox: [], agent: {}, usage } as unknown as SnapshotEvent]);
    m.mapper.applyAll([{ type: "run_end", inputs: [] }]);
    expect(m.items()).toHaveLength(written);
  });

  test("a user entry carries the request id the same batch's submission names, and a late submission adds it", () => {
    const m = mapperWith({ now: 1 });
    const entry = { id: 5, conversationId: 1, kind: "message", model: [{ role: "user", timestamp: T0, content: "hi" }] } as never;
    const placed = (requestId: string) => ({ type: "submission", record: { type: "input", id: 9, conversationId: 1, requestId, status: "placed", entry: 5 } }) as unknown as AgentEvent;
    m.mapper.applyAll([{ type: "message_end", entry }, placed("req-1")]);
    expect(m.items()).toHaveLength(1);
    expect(m.items()[0]).toMatchObject({ kind: "user", id: "e5", requestId: "req-1" });

    const late = mapperWith({ now: 1 });
    late.mapper.applyAll([{ type: "message_end", entry }]);
    expect(late.items()[0]).not.toHaveProperty("requestId");
    late.mapper.applyAll([placed("req-2")]);
    expect(late.items().map((i) => i.id)).toEqual(["e5", "e5"]); // the same id again: a replacement, not a second line
    expect(late.items()[1]).toMatchObject({ requestId: "req-2" });
  });
});

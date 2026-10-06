import {
  __resetChatTail,
  dropChatTails,
  fitChatTail,
  keepChatTtl,
  loadChatTail,
  saveChatTail,
} from "./chat-tail";
import { __resetStore, __storeIdle, getRecord, PANE_KIND_SHARE_BYTES, putRecord, utf8Bytes } from "@/lib/store";
import { paneScopeKey } from "@/lib/scope";
import type { ChatEntry } from "@/lib/types";
import { wipeDevice } from "@/lib/wipe";
import { FakeIDBFactory, uninstallFakeIndexedDB } from "@/test/fake-indexeddb";

// The Chat tail is cached as rendered blocks only (M46 spec 09): the entries the Chat body draws,
// cut to whole entries, under the lifetime the operator chose, and never while a password is asked.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
let clock = 1_800_000_000_000;

function entry(uuid: string, seq: number, text: string, extra: Partial<ChatEntry> = {}): ChatEntry {
  return { uuid, seq, ts: "", role: "assistant", parts: [{ kind: "text", text }], ...extra };
}

beforeEach(() => {
  new FakeIDBFactory().install();
  clock = 1_800_000_000_000;
  __resetStore({ now: () => clock });
  __resetChatTail();
});

afterEach(() => {
  __resetStore();
  uninstallFakeIndexedDB();
});

describe("the Chat tail", () => {
  it("writes the entries through and reads them back with the time the bridge answered", async () => {
    const entries = [entry("a", 1, "hello"), entry("b", 2, "again")];
    expect(await saveChatTail(undefined, "w1:p1", entries, "1d", clock)).toBe(true);
    const got = await loadChatTail(undefined, "w1:p1");
    expect(got?.at).toBe(clock);
    expect(got?.entries.map((e) => e.uuid)).toEqual(["a", "b"]);
  });

  it("keeps panes, sessions and machines apart", async () => {
    await saveChatTail(undefined, "w1:p1", [entry("a", 1, "hi")], "1d", clock);
    expect(await loadChatTail({ session: "demo" }, "w1:p1")).toBeNull();
    expect(await loadChatTail({ host: "bruno" }, "w1:p1")).toBeNull();
    expect(await loadChatTail(undefined, "w1:p2")).toBeNull();
  });

  it("stores the entries only: no cursor, no queue, no mirror text", async () => {
    await saveChatTail(undefined, "w1:p1", [entry("a", 1, "hi")], "1d", clock);
    const record = await getRecord("chat-tail", paneScopeKey(undefined, "w1:p1"));
    expect(Object.keys(record?.value instanceof Object ? record.value : {}).toSorted()).toEqual(["entries", "v"]);
  });

  it("cuts whole entries from the top when the tail is past its share of the pane cap", () => {
    const big = "x".repeat(10_000);
    const entries = Array.from({ length: 40 }, (_, i) => entry(`u${String(i)}`, i, big));
    const fitted = fitChatTail(entries);
    expect(fitted.length).toBeLessThan(entries.length);
    expect(fitted.length).toBeGreaterThan(0);
    // The newest survive, and every one survives whole.
    expect(fitted.at(-1)?.uuid).toBe("u39");
    expect(fitted[0]?.uuid).toBe(`u${String(40 - fitted.length)}`);
    for (const e of fitted) expect(e.parts).toEqual([{ kind: "text", text: big }]);
    expect(utf8Bytes(JSON.stringify({ v: 1, entries: fitted }))).toBeLessThanOrEqual(PANE_KIND_SHARE_BYTES);
    // One more entry would not have fitted.
    const one = entries.slice(40 - fitted.length - 1);
    expect(utf8Bytes(JSON.stringify({ v: 1, entries: one }))).toBeGreaterThan(PANE_KIND_SHARE_BYTES);
  });

  it("drops turns the agent rewound past, which the Chat body never draws", () => {
    const fitted = fitChatTail([entry("a", 1, "kept"), entry("b", 2, "gone", { abandoned: true })]);
    expect(fitted.map((e) => e.uuid)).toEqual(["a"]);
  });

  it("refuses an entry too big to fit whole, rather than storing half of it", async () => {
    const huge = entry("h", 1, "y".repeat(PANE_KIND_SHARE_BYTES));
    expect(fitChatTail([huge])).toEqual([]);
    expect(await saveChatTail(undefined, "w1:p1", [huge], "1d", clock)).toBe(false);
  });

  it("writes nothing while the setting is off", async () => {
    expect(await saveChatTail(undefined, "w1:p1", [entry("a", 1, "hi")], "off", clock)).toBe(false);
    expect(await loadChatTail(undefined, "w1:p1")).toBeNull();
  });

  it("deletes every kept tail when the setting turns off, and leaves the other kinds alone", async () => {
    await saveChatTail(undefined, "w1:p1", [entry("a", 1, "hi")], "1d", clock);
    await saveChatTail({ host: "bruno" }, "w1:p1", [entry("b", 1, "hi")], "1d", clock);
    await putRecord("pane-text", paneScopeKey(undefined, "w1:p1"), "mirror");
    await dropChatTails();
    expect(await loadChatTail(undefined, "w1:p1")).toBeNull();
    expect(await loadChatTail({ host: "bruno" }, "w1:p1")).toBeNull();
    expect(await getRecord("pane-text", paneScopeKey(undefined, "w1:p1"))).not.toBeNull();
  });

  it("takes its lifetime from the setting: 1 day, then 7 days", async () => {
    expect(keepChatTtl("off")).toBe(0);
    expect(keepChatTtl("1d")).toBe(DAY);
    expect(keepChatTtl("7d")).toBe(7 * DAY);

    await saveChatTail(undefined, "w1:p1", [entry("a", 1, "day")], "1d", clock);
    await saveChatTail(undefined, "w1:p2", [entry("b", 1, "week")], "7d", clock);
    clock += 2 * DAY;
    expect(await loadChatTail(undefined, "w1:p1")).toBeNull();
    expect((await loadChatTail(undefined, "w1:p2"))?.entries[0]?.uuid).toBe("b");
    clock += 6 * DAY;
    expect(await loadChatTail(undefined, "w1:p2")).toBeNull();
  });

  it("is wiped with the store when a pairing ends", async () => {
    await saveChatTail(undefined, "w1:p1", [entry("a", 1, "hi")], "1d", clock);
    await wipeDevice("unpair");
    await __storeIdle();
    expect(await loadChatTail(undefined, "w1:p1")).toBeNull();
  });

  it("drops a pane's tail at a password prompt, and keeps it out for a while after", async () => {
    await saveChatTail(undefined, "w1:p1", [entry("a", 1, "hi")], "1d", clock);
    await wipeDevice("password", { scope: undefined, paneId: "w1:p1" });
    await __storeIdle();
    expect(await loadChatTail(undefined, "w1:p1")).toBeNull();
    // A Chat poll landing between two mirror polls must not put it back.
    expect(await saveChatTail(undefined, "w1:p1", [entry("a", 1, "hi")], "1d", Date.now())).toBe(false);
    // Another pane is not held.
    expect(await saveChatTail(undefined, "w1:p2", [entry("b", 1, "hi")], "1d", clock)).toBe(true);
  });

  it("reads a record of another shape as a miss", async () => {
    await putRecord("chat-tail", paneScopeKey(undefined, "w1:p1"), { v: 1, entries: [{ uuid: 3 }] });
    expect(await loadChatTail(undefined, "w1:p1")).toBeNull();
    await putRecord("chat-tail", paneScopeKey(undefined, "w1:p2"), { v: 2, entries: [entry("a", 1, "x")] });
    expect(await loadChatTail(undefined, "w1:p2")).toBeNull();
  });
});

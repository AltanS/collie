import { heldChat, holdChat } from "./chat-held";
import { EMPTY_CHAT_WINDOW, markSaved, type ChatWindow } from "./chat-window";
import { paneScopeKey } from "./scope";
import { wipeDevice } from "./wipe";
import type { ChatEntry } from "./types";

// The last live window of each pane, in memory (lib/chat-held.ts): what a switch draws in its first frame.

const entry: ChatEntry = { uuid: "a", seq: 1, ts: "", role: "assistant", parts: [{ kind: "text", text: "hello" }] };
const live: ChatWindow = { ...EMPTY_CHAT_WINDOW, status: { kind: "live" }, gen: 1, rev: 1, head: 1, oldest: 1, entries: [entry] };
const key = (paneId: string) => paneScopeKey(undefined, paneId);

describe("held chat windows", () => {
  it("keeps a live window with turns and hands it back", () => {
    holdChat(key("w1:p1"), undefined, live);
    expect(heldChat(key("w1:p1"), undefined)).toBe(live);
    expect(heldChat(key("w1:p2"), undefined)).toBeNull();
  });

  it("holds nothing that is empty, unavailable or a saved copy, and drops what it held for that pane", () => {
    holdChat(key("w1:p1"), undefined, live);
    holdChat(key("w1:p1"), undefined, EMPTY_CHAT_WINDOW);
    expect(heldChat(key("w1:p1"), undefined)).toBeNull();
    holdChat(key("w1:p1"), undefined, live);
    holdChat(key("w1:p1"), undefined, markSaved(live, 5));
    expect(heldChat(key("w1:p1"), undefined)).toBeNull();
    holdChat(key("w1:p1"), undefined, { ...live, status: { kind: "unavailable", reason: "no-log" } });
    expect(heldChat(key("w1:p1"), undefined)).toBeNull();
  });

  it("belongs to one session instance, once both sides know it", () => {
    holdChat(key("w1:p1"), "aaaa", live);
    expect(heldChat(key("w1:p1"), "aaaa")).toBe(live);
    expect(heldChat(key("w1:p1"), undefined)).toBe(live);
    expect(heldChat(key("w1:p1"), "bbbb")).toBeNull();
  });

  it("keeps sixteen panes and lets the oldest go", () => {
    for (let i = 0; i < 17; i++) holdChat(key(`w1:p${i}`), undefined, live);
    expect(heldChat(key("w1:p0"), undefined)).toBeNull();
    expect(heldChat(key("w1:p1"), undefined)).toBe(live);
    expect(heldChat(key("w1:p16"), undefined)).toBe(live);
  });

  it("forgets one pane for a password prompt, and every pane when a pairing ends", async () => {
    holdChat(key("w1:p1"), undefined, live);
    holdChat(key("w1:p2"), undefined, live);
    await wipeDevice("password", { scope: undefined, paneId: "w1:p1" });
    expect(heldChat(key("w1:p1"), undefined)).toBeNull();
    expect(heldChat(key("w1:p2"), undefined)).toBe(live);
    await wipeDevice("unpair");
    expect(heldChat(key("w1:p2"), undefined)).toBeNull();
  });
});

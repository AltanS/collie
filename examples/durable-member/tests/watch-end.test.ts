// A pane whose Pi watch ends by failure says so (SDK `./pi`, reportWatchEnd). The reasons are checked with a fake pane
// on every Pi Durable version. With 1.2.0 or later the test also fails a real Session: a storage that throws closes it,
// and the watch of a conversation ends with "session_failed", the reason 1.1.0 does not have.
import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, createRegistry, watchEvents } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { reportWatchEnd } from "../pi-durable/index.ts";
import type { PaneHandle, ProgramEvent } from "../../../packages/durable-sdk/src/core/index.ts";

const piVersion: string = createRequire(import.meta.url)("@earendil-works/pi-durable/package.json").version;
const closesOnStorageError = !piVersion.startsWith("1.0.") && !piVersion.startsWith("1.1.");

/** A pane that keeps the events written to it. Only `event` is read. */
const fakePane = () => {
  const events: ProgramEvent[] = [];
  return { events, pane: { event: (e: ProgramEvent) => events.push(e) } as unknown as PaneHandle };
};
const noticeText = (events: ProgramEvent[]) => events.flatMap((e) => (e.type === "item" && e.item.kind === "notice" ? [e.item.text] : []));

describe("a watch that ended", () => {
  test("by a stop or a close, no word", () => {
    const { pane, events } = fakePane();
    reportWatchEnd(pane, "c1" as never, { reason: "stopped" });
    reportWatchEnd(pane, "c1" as never, { reason: "session_closed" });
    expect(events).toEqual([]);
  });

  test("by a failed session, a notice with the error, and the error on the log", () => {
    const { pane, events } = fakePane();
    const logged: unknown[][] = [];
    const real = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      reportWatchEnd(pane, "c1" as never, { reason: "session_failed", error: new Error("disk full") });
    } finally {
      console.error = real;
    }
    expect(noticeText(events)).toEqual(["the session failed: disk full"]);
    expect(logged).toHaveLength(1);
    expect(String(logged[0]![0])).toContain("session_failed");
  });

  test("by a listener error, a notice", () => {
    const { pane, events } = fakePane();
    const real = console.error;
    console.error = () => {};
    try {
      reportWatchEnd(pane, "c1" as never, { reason: "listener_error", error: new Error("boom") });
    } finally {
      console.error = real;
    }
    expect(noticeText(events)).toEqual(["the pane stopped updating: boom"]);
  });

  test.skipIf(!closesOnStorageError)("by a real storage error on Pi Durable 1.2.0 or later: session_failed, reported", async () => {
    const memory = new MemoryStorage();
    let failing = false;
    // Every method of the storage throws once armed, so the next commit fails the Session.
    const storage = new Proxy(memory, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (failing) throw new Error("disk full");
          return value.apply(target, args);
        };
      },
    });
    const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, ctx);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
    const stream = await watchEvents(harness, conversation.id, ctx);
    stream.start(async () => {});
    failing = true;
    await harness.commit(async (tx) => tx.scanConversations({}, 1), ctx).catch(() => {});
    const end = await stream.closed;
    expect(String(end.reason)).toBe("session_failed"); // read as text: 1.1.0 types have no such reason
    const { pane, events } = fakePane();
    const real = console.error;
    console.error = () => {};
    try {
      reportWatchEnd(pane, conversation.id, end);
    } finally {
      console.error = real;
    }
    expect(noticeText(events)).toEqual(["the session failed: disk full"]);
  });
});

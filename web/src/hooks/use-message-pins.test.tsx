import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";

import { clearStatus, useStatus } from "@/lib/status";
import type { ChatItem } from "@/lib/chat-items";
import { server } from "@/test/setup";
import { fixturePin, heldMessagePins, messagePinItemIds, setMessagePins } from "@/test/handlers";
import { useMessagePins } from "./use-message-pins";

const reply = (id: string): ChatItem => ({ id, kind: "reply", text: `text of ${id}` });

let paneNo = 0;
// A pane id of its own per case: the last list a pane answered is kept for the page's life (lib/loaders.ts).
const open = (over: { enabled?: boolean; wireCount?: number } = {}) => {
  paneNo += 1;
  const paneId = `w9:p${paneNo}`;
  return renderHook(
    (props: { enabled: boolean; wireCount: number }) => ({
      pins: useMessagePins({ paneId, scope: undefined, enabled: props.enabled, wireCount: props.wireCount }),
      status: useStatus(),
    }),
    { initialProps: { enabled: over.enabled ?? true, wireCount: over.wireCount ?? 0 } },
  );
};

afterEach(() => clearStatus());

describe("useMessagePins", () => {
  it("reads the list once when the pane opens, newest first, and counts it", async () => {
    setMessagePins([fixturePin({ itemId: "a:0", pinnedAt: 1 }), fixturePin({ itemId: "b:0", pinnedAt: 2 })]);
    const view = open();
    await waitFor(() => expect(view.result.current.pins.count).toBe(2));
    expect(view.result.current.pins.rows.map((row) => row.itemId)).toEqual(["b:0", "a:0"]);
    expect([...view.result.current.pins.pinned.keys()].toSorted()).toEqual(["a:0", "b:0"]);
  });

  it("counts by the wire until the list has been read", async () => {
    const reads: string[] = [];
    server.use(
      http.get(/\/api\/pane\/[^/]+\/pins$/, async () => {
        reads.push("read");
        await new Promise((resolve) => setTimeout(resolve, 20));
        return HttpResponse.json({ pins: [] });
      }),
    );
    const view = open({ wireCount: 3 });
    expect(view.result.current.pins.count).toBe(3);
    await waitFor(() => expect(view.result.current.pins.count).toBe(0));
    expect(reads).toEqual(["read"]);
  });

  it("follows the wire: a count that moves reads the list again", async () => {
    const view = open();
    await waitFor(() => expect(view.result.current.pins.count).toBe(0));
    setMessagePins([fixturePin({ itemId: "a:0" })]);
    view.rerender({ enabled: true, wireCount: 1 });
    await waitFor(() => expect(view.result.current.pins.count).toBe(1));
  });

  it("marks a block at once when it is pinned, keeps the row the answer brought, and reads again", async () => {
    const view = open();
    await waitFor(() => expect(view.result.current.pins.rows).toEqual([]));
    let done!: Promise<void>;
    act(() => {
      done = view.result.current.pins.pin(reply("a:0"));
    });
    expect(view.result.current.pins.pinned.get("a:0")).toBe("");
    await act(() => done);
    expect(view.result.current.pins.pinned.get("a:0")).toBe("made-1");
    expect(messagePinItemIds()).toEqual(["a:0"]);
    expect(view.result.current.pins.count).toBe(1);
  });

  it("takes the mark back and says why when the machine refuses", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/pins$/, () => HttpResponse.json({ error: "pin.cap", code: "pin.cap", message: "full" }, { status: 409 })),
    );
    const view = open();
    await waitFor(() => expect(view.result.current.pins.rows).toEqual([]));
    await act(() => view.result.current.pins.pin(reply("a:0")));
    expect(view.result.current.pins.pinned.has("a:0")).toBe(false);
    expect(view.result.current.status).toMatchObject({ text: "This session has 100 pins, unpin one first.", tone: "warn" });
  });

  it("takes a row out at once on an unpin and drops it on the machine", async () => {
    setMessagePins([fixturePin({ itemId: "a:0", id: "p1" }), fixturePin({ itemId: "b:0", id: "p2", pinnedAt: 2 })]);
    const view = open();
    await waitFor(() => expect(view.result.current.pins.count).toBe(2));
    let done!: Promise<void>;
    act(() => {
      done = view.result.current.pins.unpin("p1");
    });
    expect(view.result.current.pins.rows.map((row) => row.id)).toEqual(["p2"]);
    await act(() => done);
    expect(heldMessagePins().map((pin) => pin.id)).toEqual(["p2"]);
    expect(view.result.current.pins.count).toBe(1);
  });

  it("puts the row back where it was when an unpin is refused", async () => {
    setMessagePins([fixturePin({ itemId: "a:0", id: "p1", pinnedAt: 1 }), fixturePin({ itemId: "b:0", id: "p2", pinnedAt: 2 })]);
    server.use(http.delete(/\/api\/pane\/[^/]+\/pins$/, () => new HttpResponse("not found", { status: 404 })));
    const view = open();
    await waitFor(() => expect(view.result.current.pins.count).toBe(2));
    await act(() => view.result.current.pins.unpin("p1"));
    expect(view.result.current.pins.rows.map((row) => row.id)).toEqual(["p2", "p1"]);
    expect(view.result.current.status?.text).toBe("That machine's Collie is older and cannot keep pins. Update it.");
  });

  it("asks nothing where pins are off: an older machine, a saved copy, a pane with no session", async () => {
    setMessagePins([fixturePin({ itemId: "a:0" })]);
    const view = open({ enabled: false, wireCount: 2 });
    await act(() => view.result.current.pins.pin(reply("b:0")));
    await act(() => view.result.current.pins.unpin("p1"));
    expect(messagePinItemIds()).toEqual([]);
    expect(heldMessagePins()).toHaveLength(1);
    expect(view.result.current.pins.count).toBe(2);
  });
});

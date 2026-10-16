// The hold queue on disk (M56 spec 15): one 0600 file per held request, queue order kept across a
// restart, the three states, and the keep window of an ended row.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOLD_ENDED_KEEP_MS, HOLD_MS, HoldStore, heldRow, type HoldInput } from "./holds.ts";

let dir: string;
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "collie-holds-")), "held");
});
afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

const input = (id: string, paneId = "%1", session = "main"): HoldInput => ({ id, session, paneId, harness: "agent", mode: "send", text: `text of ${id}`, revision: 3 });

describe("HoldStore", () => {
  test("a held request is one 0600 file in a 0700 directory, with its text, ending HOLD_MS later", () => {
    const store = new HoldStore(dir, () => 5_000);
    const entry = store.add(input("req-000001"));
    expect(entry).toMatchObject({ state: "held", heldAt: 5_000, expiresAt: 5_000 + HOLD_MS, tries: 0, text: "text of req-000001" });
    expect(readdirSync(dir)).toEqual(["req-000001.json"]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "req-000001.json")).mode & 0o777).toBe(0o600);
  });

  test("a pane's queue is in hold order, across a restart, and a new hold after the restart goes last", () => {
    let now = 1_000;
    const store = new HoldStore(dir, () => now);
    store.add(input("req-000003"));
    now += 10;
    store.add(input("req-000001"));
    store.add(input("req-000009", "%2"));
    const again = new HoldStore(dir, () => now);
    expect(again.list("main", "%1").map((entry) => entry.id)).toEqual(["req-000003", "req-000001"]);
    again.add(input("req-000002"));
    expect(again.waiting("main", "%1").map((entry) => entry.id)).toEqual(["req-000003", "req-000001", "req-000002"]);
    expect(again.list("other")).toEqual([]);
  });

  test("running, put back with a try counted, ended with the text kept; waiting leaves the ended out", () => {
    const store = new HoldStore(dir, () => 1_000);
    store.add(input("req-000001"));
    store.add(input("req-000002"));
    expect(store.markRunning("req-000001")?.state).toBe("running");
    expect(store.markRunning("req-000001")).toBeNull();
    expect(store.putBack("req-000001")).toMatchObject({ state: "held", tries: 1 });
    expect(store.end("req-000002", "expired")).toMatchObject({ state: "ended", outcome: "expired", endedAt: 1_000, text: "text of req-000002" });
    expect(store.waiting("main", "%1").map((entry) => entry.id)).toEqual(["req-000001"]);
    expect(new HoldStore(dir).get("req-000002")).toMatchObject({ state: "ended", outcome: "expired" });
  });

  test("an ended row goes after the keep window; a waiting one never does", () => {
    let now = 1_000;
    const store = new HoldStore(dir, () => now);
    store.add(input("req-000001"));
    store.add(input("req-000002"));
    store.end("req-000002", "refused", "pane_gone");
    now += HOLD_ENDED_KEEP_MS + 1;
    expect(store.prune()).toBe(1);
    expect(store.list().map((entry) => entry.id)).toEqual(["req-000001"]);
  });

  test("a file this module did not write is left out", () => {
    const store = new HoldStore(dir);
    store.add(input("req-000001"));
    writeFileSync(join(dir, "req-000002.json"), "{\"id\":\"req-000002\"}\n");
    writeFileSync(join(dir, "not a request.json"), "{}\n");
    writeFileSync(join(dir, "req-000003.json"), "not json\n");
    expect(new HoldStore(dir).list().map((entry) => entry.id)).toEqual(["req-000001"]);
  });

  test("the phone's row carries the text, the times and the state, and the outcome once ended", () => {
    const store = new HoldStore(dir, () => 1_000);
    const entry = store.add(input("req-000001"));
    expect(heldRow(entry)).toEqual({ requestId: "req-000001", mode: "send", text: "text of req-000001", heldAt: 1_000, expiresAt: 1_000 + HOLD_MS, state: "held" });
    const ended = store.end("req-000001", "refused", "pane_gone")!;
    expect(heldRow(ended)).toMatchObject({ state: "ended", outcome: "refused", reason: "pane_gone" });
    expect(store.remove("req-000001")).toBe(true);
    expect(store.remove("req-000001")).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});

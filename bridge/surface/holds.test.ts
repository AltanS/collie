// The hold queue on disk (M56 spec 15): one 0600 file per held request, queue order kept across a
// restart, the three states, the keep window and caps of an ended row, and the boot cleanup.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOLD_BRIDGE_MAX, HOLD_COMMAND_MS, HOLD_ENDED_KEEP_MS, HOLD_ENDED_PANE_MAX, HOLD_MS, HOLD_PANE_MAX, HoldStore, heldRow, type HoldInput } from "./holds.ts";

let dir: string;
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "collie-holds-")), "held");
});
afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

const input = (id: string, paneId = "%1", session = "main"): HoldInput => ({ id, session, paneId, harness: "agent", mode: "send", text: `text of ${id}`, revision: 3, command: false });

describe("HoldStore", () => {
  test("a marked request (M62 spec 02) keeps its caller's end, its mark and what holds it, across a restart", () => {
    const store = new HoldStore(dir, () => 5_000);
    const entry = store.add({ ...input("req-000001"), draftHolds: true, cause: "draft_present", expiresAt: 5_000 + 60 * 60 * 1000 });
    expect(entry).toMatchObject({ draftHolds: true, cause: "draft_present", expiresAt: 5_000 + 60 * 60 * 1000 });
    expect(new HoldStore(dir, () => 5_000).get("req-000001")).toMatchObject({ draftHolds: true, cause: "draft_present", expiresAt: 5_000 + 60 * 60 * 1000 });
    // An unmarked request keeps the cause it was held from (the phone's sentence), and the store's own clock.
    const plain = store.add({ ...input("req-000002"), cause: "not_free" });
    expect(plain.cause).toBe("not_free");
    expect(plain.draftHolds).toBeUndefined();
    expect(plain.expiresAt).toBe(5_000 + HOLD_MS);
    // Every held request follows the pane (the poll), a marked one or not.
    expect(store.setCause("req-000002", "turn_running")?.cause).toBe("turn_running");
    expect(store.setCause("req-000009", "turn_running")).toBeNull();
  });

  test("every cause a refusal holds from comes back from its file and rides on the phone's row", () => {
    const store = new HoldStore(dir, () => 5_000);
    const causes = ["turn_running", "not_free", "bound", "draft_present", "probe_failed"] as const;
    causes.forEach((cause, i) => store.add({ ...input(`req-00000${String(i + 1)}`), cause }));
    const again = new HoldStore(dir, () => 5_000);
    expect(again.list().map((entry) => entry.cause)).toEqual([...causes]);
    expect(again.list().map((entry) => heldRow(entry).cause)).toEqual([...causes]);
    // A file with a cause no bridge writes reads back without one; a file without one gives a row without one.
    writeFileSync(join(dir, "req-000009.json"), `${JSON.stringify({ ...again.get("req-000001"), id: "req-000009", seq: 99, cause: "sideways" })}\n`);
    const third = new HoldStore(dir, () => 5_000);
    expect(third.get("req-000009")?.cause).toBeUndefined();
    expect(heldRow(third.get("req-000009")!)).not.toHaveProperty("cause");
  });

  test("setCause writes the file only when the cause changed, and a put-back keeps it", () => {
    const store = new HoldStore(dir, () => 5_000);
    store.add({ ...input("req-000001"), draftHolds: true, cause: "draft_present" });
    const path = join(dir, "req-000001.json");
    // A field only this test writes: a rewrite from memory would drop it.
    writeFileSync(path, `${JSON.stringify({ ...store.get("req-000001"), untouched: true })}\n`);
    expect(store.setCause("req-000001", "draft_present")?.cause).toBe("draft_present");
    expect(readFileSync(path, "utf8")).toContain('"untouched":true');
    expect(store.setCause("req-000001", "turn_running")?.cause).toBe("turn_running");
    expect(store.putBack("req-000001", false)).toMatchObject({ cause: "turn_running", draftHolds: true });
    expect(new HoldStore(dir, () => 5_000).get("req-000001")?.cause).toBe("turn_running");
  });

  test("a held request is one 0600 file in a 0700 directory, with its text, ending HOLD_MS later", () => {
    const store = new HoldStore(dir, () => 5_000);
    const entry = store.add(input("req-000001"));
    expect(entry).toMatchObject({ state: "held", heldAt: 5_000, expiresAt: 5_000 + HOLD_MS, tries: 0, text: "text of req-000001" });
    expect(readdirSync(dir)).toEqual(["req-000001.json"]);
    // Windows has no POSIX mode bits, so only the mode expectations wait for another platform.
    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "req-000001.json")).mode & 0o777).toBe(0o600);
    }
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

  test("a command that waits for a polled turn keeps the mark across a restart; one without it writes none", () => {
    const store = new HoldStore(dir, () => 1_000);
    store.add({ ...input("req-000021"), mode: "command", text: "/model", command: true, waitsForTurn: true });
    store.add({ ...input("req-000022"), waitsForTurn: false });
    const again = new HoldStore(dir, () => 1_000);
    expect(again.get("req-000021")?.waitsForTurn).toBe(true);
    expect(again.get("req-000022") && "waitsForTurn" in again.get("req-000022")!).toBe(false);
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

  test("on boot a held file that does not read back and a .tmp leftover are deleted; a foreign name is left alone", () => {
    const store = new HoldStore(dir);
    store.add(input("req-000001"));
    writeFileSync(join(dir, "req-000002.json"), "{\"id\":\"req-000002\"}\n");
    writeFileSync(join(dir, "not a request.json"), "{}\n");
    writeFileSync(join(dir, "req-000003.json"), "not json\n");
    writeFileSync(join(dir, "req-000004.json.tmp"), "{\"text\":\"half a write\"}\n");
    expect(new HoldStore(dir).list().map((entry) => entry.id)).toEqual(["req-000001"]);
    expect(readdirSync(dir).toSorted()).toEqual(["not a request.json", "req-000001.json"]);
  });

  test("a held command ends HOLD_COMMAND_MS after it was held, a text HOLD_MS", () => {
    const store = new HoldStore(dir, () => 5_000);
    expect(store.add({ ...input("req-000001"), command: true }).expiresAt).toBe(5_000 + HOLD_COMMAND_MS);
    expect(store.add(input("req-000002")).expiresAt).toBe(5_000 + HOLD_MS);
    expect(HOLD_COMMAND_MS).toBe(10 * 60 * 1000);
  });

  test("a pane keeps at most 50 ended rows for at most an hour; the oldest go first; the bridge counts its waiting rows", () => {
    let now = 1_000;
    const store = new HoldStore(dir, () => now);
    for (let i = 0; i < 52; i++) {
      const id = `req-${String(i).padStart(6, "0")}`;
      store.add(input(id));
      now += 1;
      store.end(id, "expired");
    }
    store.add(input("req-other1", "%2"));
    store.end("req-other1", "expired");
    store.add(input("req-wait01"));
    expect(store.waitingCount()).toBe(1);
    expect(store.prune()).toBe(2);
    const ended = store.list("main", "%1").filter((entry) => entry.state === "ended").map((entry) => entry.id);
    expect(ended).toHaveLength(HOLD_ENDED_PANE_MAX);
    expect(ended[0]).toBe("req-000002");
    expect(store.get("req-other1")?.state).toBe("ended");
    expect(HOLD_ENDED_KEEP_MS).toBe(60 * 60 * 1000);
    expect(HOLD_PANE_MAX).toBe(32);
    expect(HOLD_BRIDGE_MAX).toBe(256);
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

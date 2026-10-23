// world-port.ts over the fake World (M66 spec 03): the list filter and its pages, the journal's line rule, a missing
// run and a missing stream, and the version check.
import { describe, expect, test } from "bun:test";
import { harnessNameOf, journalName } from "../../../packages/durable-sdk/src/durable-harness/world-port.ts";
import { FakeWorld } from "./fake-world.ts";

describe("listRuns", () => {
  test("every status of this program's runs, any durable-harness version, oldest first, across short pages", async () => {
    const w = new FakeWorld({ pageCap: 2 });
    const a = w.addRun({ status: "running" });
    const b = w.addRun({ status: "completed", version: "0.0.1-beta.5" });
    w.addRun({ name: "other" });
    const c = w.addRun({ status: "failed" });
    const runs = await w.port().listRuns("pi-durable");
    expect(runs.map((r) => [r.runId, r.status])).toEqual([
      [a, "running"],
      [b, "completed"],
      [c, "failed"],
    ]);
    expect(w.calls.filter((c) => c === "runs.list").length).toBe(2); // two pages of 2 for 4 runs
  });

  test("the name is parsed locally, and a workflow that is not durable-harness's is no run of ours", () => {
    expect(harnessNameOf("workflow//durable-harness@0.0.1-beta.6//pi-durable")).toBe("pi-durable");
    expect(harnessNameOf("workflow//durable-harness@1.0.0//a//b")).toBe("a//b");
    expect(harnessNameOf("workflow//other@1//pi-durable")).toBeUndefined();
  });

  test("getRun: a run, or undefined for one the World does not know", async () => {
    const w = new FakeWorld();
    const id = w.addRun();
    const port = w.port();
    expect((await port.getRun(id))?.runId).toBe(id);
    expect(await port.getRun("wrun_01NOPE")).toBeUndefined();
  });
});

describe("the journal", () => {
  test("a record is one JSON line; lines are split on newlines, not on chunks, and a bad line is dropped alone", async () => {
    const w = new FakeWorld({ chunkCap: 1 });
    const id = w.addRun();
    const port = w.port();
    await port.appendJournal(id, { t: "expire", askId: "a1", at: "2026-10-21T12:00:00.000Z" });
    w.writeRaw(id, '{"t":"expire","askId":"a2",');
    w.writeRaw(id, '"at":"2026-10-21T12:00:01.000Z"}\nnot json\n{"t":"expire"}\n{"t":"nope","askId":"x","at":"y"}\n');
    await port.appendJournal(id, { t: "expire", askId: "a3", at: "2026-10-21T12:00:02.000Z", decidedBy: "program" });
    expect((await port.readJournal(id)).map((r) => (r.t === "expire" ? r.askId : r.t))).toEqual(["a1", "a2", "a3"]);
    expect(journalName(id)).toBe(`${id}_collie`);
  });

  test("a missing stream is an empty journal", async () => {
    const w = new FakeWorld();
    expect(await w.port().readJournal(w.addRun())).toEqual([]);
  });

  test("a stale World shows a write later: a reader sees a prefix, never a wrong record", async () => {
    let now = 1000;
    const w = new FakeWorld({ lagMs: 500, now: () => now });
    const id = w.addRun();
    const port = w.port();
    await port.appendJournal(id, { t: "expire", askId: "a1", at: "x" });
    expect(await port.readJournal(id)).toEqual([]);
    now += 500;
    expect((await port.readJournal(id)).length).toBe(1);
  });
});

describe("checkVersions", () => {
  test("passes on the tested durable-harness and World spec 8", async () => {
    await new FakeWorld().port().checkVersions();
  });

  test("another World spec is one line naming both versions", async () => {
    const port = new FakeWorld({ specVersion: 9 }).port();
    expect(port.checkVersions()).rejects.toThrow(/^collie: the World speaks Workflow spec 9, and .* tested on spec 8 \(@workflow\/world 5\.0\.5\) only$/);
  });
});

describe("worldIdentity", () => {
  test("a named identity is used as is", () => {
    expect(new FakeWorld().port({ identity: "one" }).worldIdentity()).toBe("one");
  });
});

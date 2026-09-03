import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { standbyUpdateAnswer, STANDBY_UPDATE_PATH } from "./pack/standby.ts";
import {
  inFlight,
  parseUpdateLock,
  parseUpdateRun,
  readUpdateRun,
  readsAsInterrupted,
  resolveUpdateRun,
  STALE_AFTER_MS,
  updateLockPath,
  updateRunPath,
  UPDATE_RUN_SCHEMA,
  type UpdateRun,
} from "./update-run.ts";

// The READ side of the update run record (M15/04). The writer is `cli/update-run.ts`; everything
// proved here is what the bridge and the standby door do with what they find on disk.

const NOW = 2_000_000_000_000;

const record = (over: Partial<UpdateRun> = {}): UpdateRun => ({
  schema: UPDATE_RUN_SCHEMA,
  state: "verifying",
  from: "v1.0.0",
  to: "v1.1.0",
  startedAt: NOW - 60_000,
  updatedAt: NOW - 60_000,
  pid: 4242,
  attempt: 0,
  ...over,
});

describe("parsing the update run record", () => {
  test("a well-formed record round-trips, and the optional fields stay optional", () => {
    const run = parseUpdateRun(JSON.stringify(record({ state: "done" })));
    expect(run?.state).toBe("done");
    expect(run?.to).toBe("v1.1.0");
    expect("reason" in (run ?? {})).toBe(false);
    const stuck = parseUpdateRun(JSON.stringify(record({ state: "stuck", reason: "no", recovery: "run me" })));
    expect(stuck?.recovery).toBe("run me");
  });

  test("a malformed record reads exactly like a missing one — half a document is no document", () => {
    expect(parseUpdateRun(null)).toBeNull();
    expect(parseUpdateRun("{not json")).toBeNull();
    // A state word nobody defined is not a state.
    expect(parseUpdateRun(JSON.stringify({ ...record(), state: "exploded" }))).toBeNull();
    // A schema this build does not know is declined rather than guessed at.
    expect(parseUpdateRun(JSON.stringify({ ...record(), schema: 99 }))).toBeNull();
  });

  test("the lock is read with the same posture", () => {
    expect(parseUpdateLock(JSON.stringify({ pid: 7, at: NOW }))).toEqual({ pid: 7, at: NOW });
    expect(parseUpdateLock('{"pid":0}')).toBeNull();
    expect(parseUpdateLock("nonsense")).toBeNull();
  });

  test("only the in-flight states can go stale", () => {
    expect(inFlight("verifying")).toBe(true);
    expect(inFlight("restarting")).toBe(true);
    expect(inFlight("done")).toBe(false);
    expect(inFlight("stuck")).toBe(false);
  });
});

describe("a stale marker", () => {
  test("a stale marker with no live updater pid reads as interrupted", () => {
    const old = record({ updatedAt: NOW - STALE_AFTER_MS - 1 });
    expect(readsAsInterrupted(old, NOW, false)).toBe(true);
    const resolved = resolveUpdateRun(old, NOW, false);
    expect(resolved.state).toBe("interrupted");
    expect(resolved.reason).toContain("pid 4242");
  });

  test("a stale marker whose updater is still alive is a SLOW run, not an interrupted one", () => {
    const old = record({ updatedAt: NOW - STALE_AFTER_MS - 1 });
    expect(readsAsInterrupted(old, NOW, true)).toBe(false);
    expect(resolveUpdateRun(old, NOW, true).state).toBe("verifying");
  });

  test("a young marker with a dead pid is left alone — a reader must not race the writer's rename", () => {
    expect(readsAsInterrupted(record({ updatedAt: NOW - 1_000 }), NOW, false)).toBe(false);
  });

  test("a terminal record never goes stale, however old it is", () => {
    expect(readsAsInterrupted(record({ state: "done", updatedAt: 0 }), NOW, false)).toBe(false);
  });

  test("the bridge reading a stale marker off disk resumes update state as interrupted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "collie-update-run-"));
    await writeFile(updateRunPath(dir), JSON.stringify(record({ updatedAt: NOW - STALE_AFTER_MS - 1 })));
    // The pid liveness question is injected, so no test ever asks the real process table.
    expect(readUpdateRun(dir, () => NOW, () => false)?.state).toBe("interrupted");
    expect(readUpdateRun(dir, () => NOW, () => true)?.state).toBe("verifying");
    // A state dir with no record at all is not an error; it is an install that has never updated.
    expect(readUpdateRun(join(dir, "empty"), () => NOW, () => false)).toBeNull();
    // The lock lives beside it, under its own name — never merged into the record.
    expect(updateLockPath(dir)).toBe(join(dir, "update.lock"));
  });
});

describe("the standby door", () => {
  const get = (path: string) => new Request(`http://d${path}`);

  test("standby update state is served while the main port is down", async () => {
    const run = record({ state: "restarting" });
    const res = standbyUpdateAnswer(get(STANDBY_UPDATE_PATH), new URL(`http://d${STANDBY_UPDATE_PATH}`), () => run);
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ ...run });
    expect(res?.headers.get("cache-control")).toBe("no-store");
  });

  test("standby update state answers `idle` when this install has never updated", async () => {
    const res = standbyUpdateAnswer(get(STANDBY_UPDATE_PATH), new URL(`http://d${STANDBY_UPDATE_PATH}`), () => null);
    expect(await res?.json()).toEqual({ state: "idle" });
  });

  test("it owns exactly one path and refuses every other method", () => {
    expect(standbyUpdateAnswer(get("/standby"), new URL("http://d/standby"), () => null)).toBeNull();
    const post = new Request(`http://d${STANDBY_UPDATE_PATH}`, { method: "POST" });
    expect(standbyUpdateAnswer(post, new URL(`http://d${STANDBY_UPDATE_PATH}`), () => null)?.status).toBe(405);
  });
});

describe("the run id (M16/04)", () => {
  test("a record carries an opaque run id, and a record without one carries no such key", () => {
    const withId = parseUpdateRun(JSON.stringify(record({ runId: "r-7" })));
    expect(withId?.runId).toBe("r-7");
    const without = parseUpdateRun(JSON.stringify(record()));
    expect("runId" in (without ?? {})).toBe(false);
  });

  test("a run id that is not a non-empty string is no run id at all", () => {
    // An empty id would MATCH another empty id, which is exactly the false positive the peer's
    // rollback memory must never make.
    expect(parseUpdateRun(JSON.stringify({ ...record(), runId: "" }))?.runId).toBeUndefined();
    expect(parseUpdateRun(JSON.stringify({ ...record(), runId: 7 }))?.runId).toBeUndefined();
  });

  test("a schema-1 record still reads whole, as a run with no id", () => {
    const older = { ...record(), schema: 1 };
    const run = parseUpdateRun(JSON.stringify(older));
    expect(run?.state).toBe("verifying");
    expect(run?.schema).toBe(1);
    expect(run?.runId).toBeUndefined();
    // A schema this build has never heard of is still declined rather than half-read.
    expect(parseUpdateRun(JSON.stringify({ ...record(), schema: 99 }))).toBeNull();
  });

  test("the rolled-back memory survives a restart — it is read off disk, never held in memory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "collie-runid-"));
    const rolled = record({ state: "rolled-back", to: "v1.1.0", runId: "r-9", reason: "health gate failed" });
    await writeFile(join(dir, "update.json"), JSON.stringify(rolled), "utf8");
    // A fresh process reads exactly what the updater left behind: the tag it fell back FROM and the
    // run it belonged to. That pair is the whole of a peer's "never twice in this run".
    const read = readUpdateRun(dir, () => NOW, () => false);
    expect(read?.state).toBe("rolled-back");
    expect(read?.to).toBe("v1.1.0");
    expect(read?.runId).toBe("r-9");
  });
});

import { describe, expect, test } from "bun:test";

import type { MachinesResponse } from "@web/lib/types";

import { emptyFeed, feedAfterAnswer, feedAfterFailure, machineCensusState } from "./crew-data";
import { sparkRuns } from "./crew-tab";

const census = (ts: number, cpu = 0.1): MachinesResponse => ({
  ts,
  machines: [{ id: "a", name: "a", isLead: true, health: "reachable", alerts: {}, firing: [], sample: { cpu, cores: 1, memUsed: 0, memTotal: 1 } }],
});

describe("feed transitions", () => {
  test("an answer stores the body and clears the flags", () => {
    const feed = feedAfterAnswer(emptyFeed<MachinesResponse>(), census(1), 10);
    expect(feed).toMatchObject({ absent: false, error: false, at: 10 });
    expect(feed.data?.ts).toBe(1);
  });

  test("an answer equal to the held one keeps every object's identity", () => {
    const first = feedAfterAnswer(emptyFeed<MachinesResponse>(), census(1), 10);
    const second = feedAfterAnswer(first, census(1), 20);
    expect(second.data).toBe(first.data);
  });

  test("a changed row is new and an unchanged row keeps its object", () => {
    const first = feedAfterAnswer(emptyFeed<MachinesResponse>(), census(1), 10);
    const next = census(2);
    const second = feedAfterAnswer(first, next, 20);
    expect(second.data).not.toBe(first.data);
    expect(second.data?.machines[0]).toBe(first.data?.machines[0]);
  });

  test("a failure keeps the last good data and flags it", () => {
    const first = feedAfterAnswer(emptyFeed<MachinesResponse>(), census(1), 10);
    const failed = feedAfterFailure(first, 500, 20);
    expect(failed.data).toBe(first.data);
    expect(failed.error).toBe(true);
    expect(failed.absent).toBe(false);
  });

  test("a 404 is an answer: no data, absent, not an error", () => {
    const first = feedAfterAnswer(emptyFeed<MachinesResponse>(), census(1), 10);
    const gone = feedAfterFailure(first, 404, 20);
    expect(gone).toMatchObject({ data: undefined, absent: true, error: false });
  });
});

describe("machineCensusState", () => {
  test("loading before any answer", () => {
    expect(machineCensusState(emptyFeed()).kind).toBe("loading");
  });

  test("census, with failed set when the last read failed", () => {
    const ok = feedAfterAnswer(emptyFeed<MachinesResponse>(), census(1), 1);
    expect(machineCensusState(ok)).toMatchObject({ kind: "census", failed: false });
    expect(machineCensusState(feedAfterFailure(ok, undefined, 2))).toMatchObject({ kind: "census", failed: true });
  });

  test("a 404 is unavailable and a first failure is the error card", () => {
    expect(machineCensusState(feedAfterFailure(emptyFeed(), 404, 1)).kind).toBe("unavailable");
    expect(machineCensusState(feedAfterFailure(emptyFeed(), 500, 1)).kind).toBe("error");
  });

  test("a failure after a 404 reads as an error, not as unavailable", () => {
    const gone = feedAfterFailure(emptyFeed<MachinesResponse>(), 404, 1);
    expect(machineCensusState(feedAfterFailure(gone, undefined, 2)).kind).toBe("error");
  });
});

describe("sparkRuns", () => {
  test("the reading now takes the right edge and a gap splits the line", () => {
    const runs = sparkRuns([0.5, null, 0.5], 30, 0.5);
    expect(runs).toHaveLength(2);
    expect(runs.at(-1)?.at(-1)?.[0]).toBe(100);
  });

  test("values older than the window are dropped, newest kept", () => {
    const values = Array.from({ length: 40 }, () => 0.2);
    const runs = sparkRuns(values, 30, null);
    expect(runs[0]).toHaveLength(30);
  });

  test("a machine watched for five minutes draws at the right, not stretched", () => {
    const runs = sparkRuns([0.1, 0.1, 0.1, 0.1, 0.1], 30, 0.1);
    expect(runs[0]?.[0]?.[0]).toBeGreaterThan(70);
  });
});

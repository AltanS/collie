import { describe, expect, test } from "bun:test";

import { parseUsageRecord, usageAt, type UsageRecord } from "../bridge/usage.ts";
import { fakeFiles, STATE } from "./fakes.ts";
import { mergeBeacon, mergeStatusLine, readUsage, usagePath, writeUsage } from "./usage-store.ts";

// One file, two writers (.adr/0115): neither the statusLine wrapper nor the beacon hooks may erase the
// fields only the other one knows.

const NOW = 1_800_000_000_000;
const SESSION = "ff2dd3c2-e3d5-40db-9474-eea02e606c6c";
const FIVE_HOUR = { window: "5h", used: 23.5, resetsAt: NOW + 3_600_000 } as const;
const SEVEN_DAY = { window: "7d", used: 41.2, resetsAt: NOW + 500_000_000 } as const;

const record = (over: Partial<UsageRecord> = {}): UsageRecord => ({ schemaVersion: 1, harness: "claude", at: NOW - 1000, ...over });

describe("the beacon side of the merge", () => {
  test("replaces the context and keeps the window and the running limits", () => {
    const existing = record({ context: 3, window: 1_000_000, limits: [FIVE_HOUR, SEVEN_DAY] });
    const merged = mergeBeacon(existing, "claude", NOW, { context: 40 });
    expect(merged).toEqual({ ...existing, context: 40 });
  });

  test("removes the context on null, and keeps the rest", () => {
    const existing = record({ context: 3, window: 200_000, limits: [FIVE_HOUR] });
    const merged = mergeBeacon(existing, "claude", NOW, { context: null });
    expect(merged?.context).toBeUndefined();
    expect(merged).toMatchObject({ window: 200_000, limits: [FIVE_HOUR] });
  });

  test("drops a window that has reset, and then stamps the write itself", () => {
    const merged = mergeBeacon(record({ context: 3, limits: [{ window: "5h", used: 9, resetsAt: NOW - 1 }] }), "claude", NOW, { context: 4 });
    expect(merged?.limits).toBeUndefined();
    expect(merged?.at).toBe(NOW);
  });

  test("a limit with no reset time is kept, as the bridge keeps it", () => {
    const merged = mergeBeacon(record({ context: 3, limits: [{ window: "5h", used: 9 }] }), "claude", NOW, { context: 4 });
    expect(merged?.limits).toEqual([{ window: "5h", used: 9 }]);
  });

  test("is no write when nothing changed in whole percents", () => {
    const existing = record({ context: 15.2, window: 1_000_000 });
    expect(mergeBeacon(existing, "claude", NOW, { context: 15 })).toBeNull();
    expect(mergeBeacon(existing, "claude", NOW, { window: 1_000_000 })).toBeNull();
    expect(mergeBeacon(existing, "claude", NOW, { context: 16 })).not.toBeNull();
    expect(mergeBeacon(existing, "claude", NOW, { context: null })).not.toBeNull();
  });

  test("starts a file when there is none", () => {
    expect(mergeBeacon(null, "claude", NOW, { window: 200_000 })).toEqual({ schemaVersion: 1, harness: "claude", at: NOW, window: 200_000 });
  });
});

describe("the statusLine side of the merge", () => {
  test("replaces the context and the limits and keeps the window", () => {
    const existing = record({ context: 3, window: 1_000_000, limits: [{ window: "5h", used: 1, resetsAt: NOW + 1000 }] });
    const reading = record({ at: NOW, context: 42, limits: [FIVE_HOUR, SEVEN_DAY] });
    expect(mergeStatusLine(existing, reading, NOW)).toEqual({ ...reading, window: 1_000_000 });
  });

  test("a reading without a context keeps the beacon's; without limits keeps the running ones", () => {
    const existing = record({ context: 33, window: 200_000, limits: [FIVE_HOUR] });
    const merged = mergeStatusLine(existing, record({ at: NOW }), NOW);
    expect(merged).toMatchObject({ context: 33, window: 200_000, limits: [FIVE_HOUR], at: existing.at });
  });

  test("with no file yet it is the reading as it came", () => {
    const reading = record({ at: NOW, context: 42 });
    expect(mergeStatusLine(null, reading, NOW)).toEqual(reading);
  });
});

describe("both writers through the disk", () => {
  const deps = () => ({ files: fakeFiles({}), uid: 1000 });

  test("the beacon after the wrapper and the wrapper after the beacon each leave the other's fields", () => {
    const d = deps();
    const write = (r: UsageRecord | null): void => {
      if (r !== null) writeUsage(d, STATE, SESSION, r);
    };
    // The start notes the window; the wrapper reports context and both limits; the transcript reading moves the context.
    write(mergeBeacon(readUsage(d, STATE, SESSION), "claude", NOW - 20_000, { window: 1_000_000 }));
    write(mergeStatusLine(readUsage(d, STATE, SESSION), record({ at: NOW - 10_000, context: 42, limits: [FIVE_HOUR, SEVEN_DAY] }), NOW - 10_000));
    write(mergeBeacon(readUsage(d, STATE, SESSION), "claude", NOW, { context: 55 }));
    expect(readUsage(d, STATE, SESSION)).toEqual({ schemaVersion: 1, harness: "claude", at: NOW - 10_000, context: 55, window: 1_000_000, limits: [FIVE_HOUR, SEVEN_DAY] });
    write(mergeStatusLine(readUsage(d, STATE, SESSION), record({ at: NOW + 1000, context: 56 }), NOW + 1000));
    expect(readUsage(d, STATE, SESSION)).toMatchObject({ context: 56, window: 1_000_000, limits: [FIVE_HOUR, SEVEN_DAY] });
    // What the bridge draws never includes the window.
    expect(usageAt(readUsage(d, STATE, SESSION)!, NOW)).toEqual({ context: 56, limits: [FIVE_HOUR, SEVEN_DAY] });
  });

  test("a file that does not parse is replaced, not merged", () => {
    const d = deps();
    d.files.write(usagePath(STATE, SESSION), "{not json");
    expect(readUsage(d, STATE, SESSION)).toBeNull();
    writeUsage(d, STATE, SESSION, mergeBeacon(null, "claude", NOW, { context: 5 })!);
    expect(parseUsageRecord(d.files.read(usagePath(STATE, SESSION)) ?? "")?.context).toBe(5);
  });

  test("a folder another user can write into takes nothing", () => {
    const d = deps();
    d.files.mkdirp(`${STATE}/usage`, 0o777);
    writeUsage(d, STATE, SESSION, record({ context: 1 }));
    expect(d.files.read(usagePath(STATE, SESSION))).toBeNull();
  });
});

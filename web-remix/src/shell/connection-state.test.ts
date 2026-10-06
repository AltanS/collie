/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import { CONNECTION_LOST_MS, TROUBLE_MS } from "@web/lib/connection-health";

import { deriveConnection, LIVE, nextCrossing, type ConnectionInput } from "./connection-state";

const base: ConnectionInput = { bridge: "connected", error: false, stalled: false, anchor: 1_000, now: 1_000, uploading: false };
const at = (ms: number, over: Partial<ConnectionInput> = {}): ConnectionInput => ({ ...base, ...over, now: base.anchor + ms });

describe("deriveConnection", () => {
  test("a live snapshot is live however old the anchor is", () => {
    expect(deriveConnection(at(60_000))).toBe(LIVE);
  });

  test("not live: nothing until TROUBLE_MS, trouble from there, lost from CONNECTION_LOST_MS", () => {
    const failing = { error: true };
    expect(deriveConnection(at(TROUBLE_MS - 1, failing))).toEqual({ connecting: true, trouble: false, lost: false });
    expect(deriveConnection(at(TROUBLE_MS, failing))).toEqual({ connecting: true, trouble: true, lost: false });
    expect(deriveConnection(at(CONNECTION_LOST_MS, failing))).toEqual({ connecting: true, trouble: true, lost: true });
  });

  test("no snapshot yet, a disconnected Herdr and a stalled load all count as not live", () => {
    expect(deriveConnection(at(5_000, { bridge: undefined })).trouble).toBe(true);
    expect(deriveConnection(at(5_000, { bridge: "disconnected" })).trouble).toBe(true);
    expect(deriveConnection(at(5_000, { stalled: true })).trouble).toBe(true);
  });

  test("an upload in flight suspends both thresholds", () => {
    expect(deriveConnection(at(60_000, { error: true, uploading: true }))).toEqual({ connecting: true, trouble: false, lost: false });
  });
});

describe("nextCrossing", () => {
  test("counts down to the amber threshold, then to the red one, then stops", () => {
    const failing = { error: true };
    const early = at(1_000, failing);
    expect(nextCrossing(early, deriveConnection(early))).toBe(TROUBLE_MS - 1_000);
    const amber = at(TROUBLE_MS + 1_000, failing);
    expect(nextCrossing(amber, deriveConnection(amber))).toBe(CONNECTION_LOST_MS - TROUBLE_MS - 1_000);
    const red = at(CONNECTION_LOST_MS, failing);
    expect(nextCrossing(red, deriveConnection(red))).toBeNull();
  });

  test("nothing is pending while live or uploading", () => {
    expect(nextCrossing(base, LIVE)).toBeNull();
    const up = at(0, { error: true, uploading: true });
    expect(nextCrossing(up, deriveConnection(up))).toBeNull();
  });
});

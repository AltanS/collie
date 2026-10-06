/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import type { UpdateInfo } from "@web/lib/types";

import { pendingUpdate } from "./updates-status";

function info(over: Partial<UpdateInfo>): UpdateInfo {
  return {
    current: "1.17.0",
    latest: "1.17.0",
    latestUrl: null,
    releaseAvailable: false,
    majorAvailable: null,
    majorUrl: null,
    bridgeStale: false,
    checkedAt: 0,
    ...over,
  };
}

describe("pendingUpdate", () => {
  test("nothing waits on a current install, or on no update block at all", () => {
    expect(pendingUpdate(info({}))).toBeNull();
    expect(pendingUpdate(undefined)).toBeNull();
  });
  test("a package swap under a live process outranks a stale process", () => {
    expect(pendingUpdate(info({ restartNeeded: true, restartCommand: "collie restart", bridgeStale: true }))).toBe("restart-needed");
  });
  test("a stale process outranks a release, a release outranks a major", () => {
    expect(pendingUpdate(info({ bridgeStale: true, releaseAvailable: true }))).toBe("restart");
    expect(pendingUpdate(info({ releaseAvailable: true, latest: "1.18.0", majorAvailable: "2.0.0" }))).toBe("release");
    expect(pendingUpdate(info({ majorAvailable: "2.0.0" }))).toBe("major");
  });
  test("a release with no version string says nothing", () => {
    expect(pendingUpdate(info({ releaseAvailable: true, latest: null }))).toBeNull();
  });
});

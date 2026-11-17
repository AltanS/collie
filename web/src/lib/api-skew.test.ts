import { beforeEach, describe, expect, it, vi } from "vitest";

import { __resetApiSkew, noteServerApiVersion } from "./api-skew";
import { API_VERSION, apiVersionsDiffer } from "./api-version";
import { currentStatus } from "./status";

// M102 spec 14 decision 4: `/api/config` carries the bridge's API number, and the phone says once per
// page load when its bundle's number differs. There was no version word at all before.

describe("the API number", () => {
  beforeEach(() => {
    __resetApiSkew();
    vi.useFakeTimers();
  });

  it("differs only for a whole number that is not the bundle's", () => {
    expect(apiVersionsDiffer(API_VERSION)).toBe(false);
    expect(apiVersionsDiffer(API_VERSION + 1)).toBe(true);
    expect(apiVersionsDiffer(0, 1)).toBe(true);
    // An older bridge sends none, and a malformed value says nothing either.
    expect(apiVersionsDiffer(undefined)).toBe(false);
    expect(apiVersionsDiffer("2")).toBe(false);
    expect(apiVersionsDiffer(1.5)).toBe(false);
  });

  it("says so once per page load, and never for the same number", () => {
    noteServerApiVersion(API_VERSION);
    expect(currentStatus()).toBeNull();
    noteServerApiVersion(API_VERSION + 1);
    const first = currentStatus();
    expect(first?.text).toBe("This page comes from another Collie version than this machine. It reloads when nothing unsent is open.");
    expect(first?.tone).toBe("warn");
    vi.advanceTimersByTime(10_000);
    expect(currentStatus()).toBeNull();
    noteServerApiVersion(API_VERSION + 1);
    expect(currentStatus()).toBeNull();
  });
});

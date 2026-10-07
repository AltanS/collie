// The URL builders (`lib/urls.ts`) against the strings this shell wrote by hand before they existed.
// Every `expected` below is the old literal or template, spelled the old way, so a builder that drifts
// from what the wire carried fails here and not on a phone.
import { describe, expect, test } from "bun:test";

import {
  cacheWatchForgetUrl,
  cacheWatchListUrl,
  cacheWatchUrl,
  configUrl,
  crewUrl,
  devicesRevokeUrl,
  devicesUrl,
  launchersUrl,
  machineAlertsUrl,
  machineHistoryUrl,
  machinesUrl,
  notificationPrefsUrl,
  paneChangesUrl,
  paneFilesUrl,
  paneHistoryUrl,
  pairUrl,
  snapshotUrl,
  snoozeUrl,
  subscribeUrl,
  updateCheckRunUrl,
  updateCheckUrl,
  workspaceChangesUrl,
  workspaceFilesUrl,
} from "./urls";

/** Ids a mux hands out (dotted, colon, plain) and ids that need percent-encoding. */
const IDS = [
  "w1.p1",
  "w1.p1.2",
  "p_7",
  "w1:p1",
  "a b",
  "a/b",
  "é",
  "100%",
  "50%2E",
  "x?y=1&z#h",
  "a+b",
  "it's (1)!~*",
  "..",
  ".",
  "-.-",
];

describe("fixed paths", () => {
  test("each equals the literal it replaced", () => {
    expect(snapshotUrl()).toBe("/api/snapshot");
    expect(configUrl()).toBe("/api/config");
    expect(pairUrl()).toBe("/api/pair");
    expect(devicesUrl()).toBe("/api/devices");
    expect(devicesRevokeUrl()).toBe("/api/devices/revoke");
    expect(crewUrl()).toBe("/api/crew");
    expect(machinesUrl()).toBe("/api/machines");
    expect(launchersUrl()).toBe("/api/launchers");
    expect(notificationPrefsUrl()).toBe("/api/notifications/prefs");
    expect(cacheWatchUrl()).toBe("/api/notifications/cache-watch");
    expect(cacheWatchListUrl()).toBe("/api/notifications/cache-watch/list");
    expect(cacheWatchForgetUrl()).toBe("/api/notifications/cache-watch/forget");
    expect(snoozeUrl()).toBe("/api/notifications/snooze");
    expect(subscribeUrl()).toBe("/api/subscribe");
    expect(updateCheckUrl()).toBe("/api/update/check");
    expect(updateCheckRunUrl()).toBe("/api/update/check");
  });

  test("the callers' query suffixes still compose to the old strings", () => {
    expect(`${machinesUrl()}?spark=${String(30)}`).toBe("/api/machines?spark=30");
    expect(`${cacheWatchUrl()}?pane=${encodeURIComponent("w1.p1")}`).toBe("/api/notifications/cache-watch?pane=w1.p1");
    expect(`${paneHistoryUrl("w1.p1")}?limit=20`).toBe("/api/pane/w1.p1/history?limit=20");
  });
});

describe("param paths", () => {
  test("a dotted pane id keeps its dot bare, as encodeURIComponent writes it", () => {
    expect(paneChangesUrl("w1.p1")).toBe("/api/pane/w1.p1/changes");
    expect(paneFilesUrl("w1.p1")).toBe("/api/pane/w1.p1/files");
    expect(paneHistoryUrl("w1.p1")).toBe("/api/pane/w1.p1/history");
  });

  test("a param that needs percent-encoding is encoded as encodeURIComponent encodes it", () => {
    expect(paneChangesUrl("a b/c")).toBe("/api/pane/a%20b%2Fc/changes");
    expect(workspaceChangesUrl("w:1")).toBe("/api/workspace/w%3A1/changes");
    expect(machineHistoryUrl("é?&#")).toBe("/api/machines/%C3%A9%3F%26%23/history");
  });

  test("a literal percent sign is not mistaken for an encoded dot", () => {
    expect(paneChangesUrl("50%2E")).toBe("/api/pane/50%252E/changes");
  });

  test("every builder equals the old template for every id", () => {
    for (const id of IDS) {
      const e = encodeURIComponent(id);
      expect(paneChangesUrl(id)).toBe(`/api/pane/${e}/changes`);
      expect(paneFilesUrl(id)).toBe(`/api/pane/${e}/files`);
      expect(paneHistoryUrl(id)).toBe(`/api/pane/${e}/history`);
      expect(workspaceChangesUrl(id)).toBe(`/api/workspace/${e}/changes`);
      expect(workspaceFilesUrl(id)).toBe(`/api/workspace/${e}/files`);
      expect(machineHistoryUrl(id)).toBe(`/api/machines/${e}/history`);
      expect(machineAlertsUrl(id)).toBe(`/api/machines/${e}/alerts`);
    }
  });
});

import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { server } from "@/test/setup";

import { isFresh, onceEntry, recordEntry } from "./once";
import { signalTrouble } from "./store";

const KEY = "collie:trouble-signalled:v1";
const DAY1 = Date.parse("2026-11-07T10:00:00Z");
const DAY2 = Date.parse("2026-11-08T00:00:01Z");

function capture(): unknown[] {
  const posted: unknown[] = [];
  server.use(
    http.get("/api/report/context", () => HttpResponse.json({ collie: "1.28.0", line: "stable", os: "linux", arch: "x64", mux: "herdr", harness: "claude", screenable: false })),
    http.post("/api/telemetry/trouble", async ({ request }) => {
      posted.push(await request.json());
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return posted;
}

afterEach(() => vi.useRealTimers());

describe("the once-a-day gate (pure)", () => {
  it("names an entry by kind, pane and UTC day", () => {
    expect(onceEntry("dialog", "lead|w1:p1", DAY1)).toBe("dialog|lead|w1:p1|2026-11-07");
    expect(onceEntry("dialog", "lead|w1:p1", DAY2)).toBe("dialog|lead|w1:p1|2026-11-08");
  });

  it("is fresh until the entry is recorded, and recording drops other days", () => {
    const old = onceEntry("send", "lead|w1:p1", DAY1);
    const today = onceEntry("dialog", "lead|w1:p2", DAY2);
    expect(isFresh([old], today)).toBe(true);
    expect(recordEntry([old], today, DAY2)).toEqual([today]);
    expect(recordEntry([today], today, DAY2)).toEqual([today]);
    expect(isFresh([today], today)).toBe(false);
  });
});

describe("signalTrouble once per kind, pane and UTC day", () => {
  it("posts once for the same kind and pane in a day, again for another pane, kind or day", async () => {
    const posted = capture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(DAY1);
    await signalTrouble({ kind: "dialog", paneId: "w1:p1", agent: "claude" });
    await signalTrouble({ kind: "dialog", paneId: "w1:p1", agent: "claude" });
    expect(posted).toHaveLength(1);
    await signalTrouble({ kind: "dialog", paneId: "w1:p2", agent: "claude" });
    expect(posted).toHaveLength(2);
    await signalTrouble({ kind: "send", paneId: "w1:p1", requestIds: [] });
    expect(posted).toHaveLength(3);
    vi.setSystemTime(DAY2);
    await signalTrouble({ kind: "dialog", paneId: "w1:p1", agent: "claude" });
    expect(posted).toHaveLength(4);
  });

  it("prunes yesterday's entries on the next write and keeps the pane id out of the body", async () => {
    const posted = capture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(DAY1);
    await signalTrouble({ kind: "dialog", paneId: "w1:p1", agent: "claude" });
    expect(JSON.parse(localStorage.getItem(KEY) ?? "[]")).toEqual(["dialog|lead|w1:p1|2026-11-07"]);
    vi.setSystemTime(DAY2);
    await signalTrouble({ kind: "dialog", paneId: "w1:p2", agent: "claude" });
    expect(JSON.parse(localStorage.getItem(KEY) ?? "[]")).toEqual(["dialog|lead|w1:p2|2026-11-08"]);
    expect(JSON.stringify(posted)).not.toContain("w1:p");
  });

  it("posts every time when storage throws", async () => {
    const posted = capture();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await signalTrouble({ kind: "dialog", paneId: "w1:p1", agent: "claude" });
    await signalTrouble({ kind: "dialog", paneId: "w1:p1", agent: "claude" });
    expect(posted).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it("posts for the same kind and pane id on two crew hosts", async () => {
    const posted = capture();
    await signalTrouble({ kind: "dialog", paneId: "w1:p1", scope: { host: "bluefin-hc" }, agent: "claude" });
    await signalTrouble({ kind: "dialog", paneId: "w1:p1", scope: { host: "minibuch-hc" }, agent: "claude" });
    await signalTrouble({ kind: "dialog", paneId: "w1:p1", scope: { host: "minibuch-hc" }, agent: "claude" });
    expect(posted).toHaveLength(2);
  });

  it("does not post twice when two cards signal in the same moment", async () => {
    const posted = capture();
    await Promise.all([signalTrouble({ kind: "dialog", paneId: "w1:p1", agent: "claude" }), signalTrouble({ kind: "dialog", paneId: "w1:p1", agent: "claude" })]);
    expect(posted).toHaveLength(1);
  });
});

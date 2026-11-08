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

  it("puts a dialog's screen hash in the entry, and leaves the entry as it was without one (1.27.4)", () => {
    expect(onceEntry("dialog", "lead|w1:p1", DAY1, "cd5c9922")).toBe("dialog|lead|w1:p1|cd5c9922|2026-11-07");
    expect(onceEntry("dialog", "lead|w1:p1", DAY1, null)).toBe("dialog|lead|w1:p1|2026-11-07");
    expect(onceEntry("dialog", "lead|w1:p1", DAY1, undefined)).toBe("dialog|lead|w1:p1|2026-11-07");
    // A hash out of shape, or on a send, is no part of the entry, as it is no part of the signal.
    expect(onceEntry("dialog", "lead|w1:p1", DAY1, "CD5C9922")).toBe("dialog|lead|w1:p1|2026-11-07");
    expect(onceEntry("send", "lead|w1:p1", DAY1, "cd5c9922")).toBe("send|lead|w1:p1|2026-11-07");
    // A screened entry is still today's, so the next day's write drops it.
    const screened = onceEntry("dialog", "lead|w1:p1", DAY1, "cd5c9922");
    expect(recordEntry([screened], onceEntry("dialog", "lead|w1:p2", DAY2), DAY2)).toEqual(["dialog|lead|w1:p2|2026-11-08"]);
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

  it("counts two different dialogs on one pane in a day apart, and one dialog re-mounted once (1.27.4)", async () => {
    const posted = capture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(DAY1);
    await signalTrouble({ kind: "dialog", paneId: "w1:p1", agent: "claude", screen: "cd5c9922" });
    // The same dialog re-mounted (a pane switch, a reload): no second post.
    await signalTrouble({ kind: "dialog", paneId: "w1:p1", agent: "claude", screen: "cd5c9922" });
    expect(posted).toHaveLength(1);
    // Another dialog on the same pane the same day: its own post.
    await signalTrouble({ kind: "dialog", paneId: "w1:p1", agent: "claude", screen: "634c6530" });
    expect(posted).toHaveLength(2);
    await signalTrouble({ kind: "dialog", paneId: "w1:p1", agent: "claude", screen: "634c6530" });
    expect(posted).toHaveLength(2);
    expect(posted).toMatchObject([{ kind: "dialog", screen: "cd5c9922" }, { kind: "dialog", screen: "634c6530" }]);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "[]")).toEqual(["dialog|lead|w1:p1|cd5c9922|2026-11-07", "dialog|lead|w1:p1|634c6530|2026-11-07"]);
  });

  it("keeps one entry per pane and day for a dialog with no hash, whatever the dialog (1.27.4)", async () => {
    const posted = capture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(DAY1);
    await signalTrouble({ kind: "dialog", paneId: "w1:p1", agent: "claude", screen: null });
    await signalTrouble({ kind: "dialog", paneId: "w1:p1", agent: "claude" });
    expect(posted).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "[]")).toEqual(["dialog|lead|w1:p1|2026-11-07"]);
  });
});

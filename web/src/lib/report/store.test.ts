import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "@/test/setup";

import { closeReport, closeTrouble, EPISODE_MAX, EPISODE_MAX_AGE_MS, noteSend, openReport, readEpisodes, streakIds, troubleOf, useReportTarget, useTroubleOffer } from "./store";

const KEY = "lead|default|w1:p1";
const T0 = Date.parse("2026-10-25T18:00:00Z");

function fail(n: number, at = T0 + n * 1000) {
  return { requestId: `st-${String(n).padStart(6, "0")}`, outcome: "refused" as const, reason: "probe_failed" as const, at };
}

describe("the streak store (ADR 0123)", () => {
  it("names the count once the third failure lands, and closing silences it until a success", () => {
    const { result } = renderHook(() => useTroubleOffer(KEY));
    expect(result.current).toBe(0);
    act(() => {
      noteSend(KEY, "w1:p1", fail(1));
      noteSend(KEY, "w1:p1", fail(2));
    });
    expect(result.current).toBe(0);
    act(() => void noteSend(KEY, "w1:p1", fail(3)));
    expect(result.current).toBe(3);
    expect(streakIds(KEY)).toEqual(["st-000001", "st-000002", "st-000003"]);
    act(() => closeTrouble(KEY));
    expect(result.current).toBe(0);
    act(() => void noteSend(KEY, "w1:p1", { requestId: "st-ok-00001", outcome: "sent", reason: null, at: T0 + 9000 }));
    expect(troubleOf(KEY).sends).toEqual([]);
  });

  it("keeps panes apart", () => {
    for (let n = 1; n <= 3; n++) noteSend(KEY, "w1:p1", fail(n));
    expect(troubleOf("lead|default|w1:p2").sends).toEqual([]);
  });

  it("logs one shape-only episode when a streak reaches the threshold, and none for the failures after it", () => {
    for (let n = 1; n <= 5; n++) noteSend(KEY, "w1:p1", fail(n), T0 + 10_000);
    const episodes = readEpisodes(T0 + 10_000);
    expect(episodes).toEqual([
      { at: T0 + 3000, paneId: "w1:p1", sends: [1, 2, 3].map((n) => ({ requestId: `st-${String(n).padStart(6, "0")}`, outcome: "refused", reason: "probe_failed" })) },
    ]);
    expect(JSON.stringify(localStorage.getItem("collie:report-episodes:v1"))).not.toContain("text");
  });

  it("keeps at most twenty episodes, none older than seven days", () => {
    const stored = Array.from({ length: 25 }, (_, i) => ({ at: T0 + i, paneId: `p${String(i)}`, sends: [] }));
    localStorage.setItem("collie:report-episodes:v1", JSON.stringify([{ at: T0 - EPISODE_MAX_AGE_MS - 1, paneId: "old", sends: [] }, ...stored]));
    const episodes = readEpisodes(T0 + 100);
    expect(episodes).toHaveLength(EPISODE_MAX);
    expect(episodes[0]!.paneId).toBe("p5");
    expect(episodes.some((e) => e.paneId === "old")).toBe(false);
    localStorage.setItem("collie:report-episodes:v1", "not json");
    expect(readEpisodes(T0)).toEqual([]);
  });

  it("opens and closes the one sheet", () => {
    const { result } = renderHook(() => useReportTarget());
    expect(result.current).toBeNull();
    act(() => openReport({ paneId: "w1:p1", requestIds: ["a"] }));
    expect(result.current).toEqual({ paneId: "w1:p1", requestIds: ["a"] });
    act(() => closeReport());
    expect(result.current).toBeNull();
  });
});

describe("the trouble signal from a streak (M86 spec 05)", () => {
  it("posts once per streak, when the card is first offered, with the four names and no pane id", async () => {
    const posted: unknown[] = [];
    server.use(
      http.get("/api/report/context", () => HttpResponse.json({ collie: "1.27.0", line: "stable", os: "linux", arch: "x64", mux: "herdr-core", harness: "codex", screenable: false })),
      http.post("/api/telemetry/trouble", async ({ request }) => {
        posted.push(await request.json());
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const key = "lead|default|w9:p1";
    noteSend(key, "w9:p1", fail(1));
    noteSend(key, "w9:p1", fail(2));
    expect(posted).toEqual([]);
    noteSend(key, "w9:p1", fail(3));
    await waitFor(() => expect(posted).toHaveLength(1));
    // The fourth and fifth failure of the same streak keep the card; they are not new signals.
    noteSend(key, "w9:p1", fail(4));
    noteSend(key, "w9:p1", fail(5));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(posted).toEqual([{ kind: "send", harness: "codex", version: null, mux: "herdr-core" }]);
    expect(JSON.stringify(posted)).not.toContain("w9:p1");
  });
});

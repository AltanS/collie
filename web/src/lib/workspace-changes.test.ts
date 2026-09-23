import { describe, expect, it } from "vitest";

import { runPool, summarizeChanges } from "./workspace-changes";

describe("summarizeChanges", () => {
  it("sums files and lines over every repo", () => {
    expect(
      summarizeChanges({
        available: true,
        root: "/r",
        truncated: false,
        repos: [
          { relPath: ".", name: "r", files: [{ path: "a", status: "M", added: 3, removed: 1, binary: false }] },
          {
            relPath: "sub",
            name: "sub",
            files: [
              { path: "b", status: "A", added: 4, removed: 0, binary: false },
              { path: "c.png", status: "M", added: 0, removed: 0, binary: true },
            ],
          },
        ],
      }),
    ).toEqual({ kind: "changed", files: 3, added: 7, removed: 1 });
  });

  it("calls a repo list with no files clean", () => {
    expect(summarizeChanges({ available: true, root: "/r", truncated: false, repos: [] })).toEqual({ kind: "clean" });
  });

  it("names a workspace with no folder, and calls every other refusal unavailable", () => {
    expect(summarizeChanges({ available: false, reason: "no-folder" })).toEqual({ kind: "no-folder" });
    expect(summarizeChanges({ available: false, reason: "no-git" })).toEqual({ kind: "unavailable" });
  });
});

describe("runPool", () => {
  it("never runs more than the limit at once, and runs every task", async () => {
    let inFlight = 0;
    let peak = 0;
    const done: number[] = [];
    const tasks = Array.from({ length: 7 }, (_, i) => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      done.push(i);
    });
    await runPool(tasks, 3);
    expect(peak).toBe(3);
    expect(done.toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("keeps going past a failed task", async () => {
    const done: string[] = [];
    await runPool(
      [
        () => Promise.reject(new Error("boom")),
        async () => {
          done.push("second");
        },
      ],
      1,
    );
    expect(done).toEqual(["second"]);
  });
});

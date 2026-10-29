import { renderHook, act } from "@testing-library/react";

import { useDiffComments } from "@/hooks/use-diff-comments";
import {
  clearDiffComments,
  forgetAllDiffComments,
  loadDiffComments,
  saveDiffComments,
} from "./diff-comment-store";
import type { DiffComment } from "./diff-comments";

const comment = (id: number, over: Partial<DiffComment> = {}): DiffComment => ({
  id,
  fileKey: "changes\n.\nsrc/a.ts",
  repo: ".",
  path: "src/a.ts",
  rowKeys: ["add::1:x"],
  lineLabel: "+1",
  linesText: ["+x"],
  note: `note ${id}`,
  ...over,
});

afterEach(() => sessionStorage.clear());

describe("the kept batch of diff comments", () => {
  it("round-trips a batch under its scope and target", () => {
    saveDiffComments({ host: "workshop" }, "pane:w1:p1", [comment(1), comment(2, { fileKey: undefined })]);
    expect(loadDiffComments({ host: "workshop" }, "pane:w1:p1")).toEqual([
      comment(1),
      comment(2, { fileKey: undefined }),
    ]);
  });

  it("keeps one batch per scope and per target", () => {
    saveDiffComments(undefined, "pane:w1:p1", [comment(1)]);
    expect(loadDiffComments({ host: "workshop" }, "pane:w1:p1")).toEqual([]);
    expect(loadDiffComments(undefined, "space:w1")).toEqual([]);
    expect(loadDiffComments(undefined, "pane:w1:p1")).toHaveLength(1);
  });

  it("keeps nothing for an empty or cleared batch", () => {
    saveDiffComments(undefined, "pane:w1:p1", [comment(1)]);
    expect(sessionStorage.length).toBe(1);
    clearDiffComments(undefined, "pane:w1:p1");
    expect(sessionStorage.length).toBe(0);
    saveDiffComments(undefined, "pane:w1:p1", []);
    expect(sessionStorage.length).toBe(0);
  });

  it("drops a damaged entry and keeps the readable ones", () => {
    saveDiffComments(undefined, "pane:w1:p1", [comment(1)]);
    const key = sessionStorage.key(0)!;
    sessionStorage.setItem(key, JSON.stringify([{ id: "x" }, JSON.parse(sessionStorage.getItem(key)!)[0]]));
    expect(loadDiffComments(undefined, "pane:w1:p1").map((c) => c.id)).toEqual([1]);
    sessionStorage.setItem(key, "{not json");
    expect(loadDiffComments(undefined, "pane:w1:p1")).toEqual([]);
  });

  it("forgets every held batch and nothing else", () => {
    saveDiffComments(undefined, "pane:w1:p1", [comment(1)]);
    saveDiffComments({ host: "workshop" }, "space:w2", [comment(2)]);
    sessionStorage.setItem("collie.nav.trail", "[]");
    forgetAllDiffComments();
    expect(sessionStorage.length).toBe(1);
    expect(sessionStorage.getItem("collie.nav.trail")).toBe("[]");
  });
});

describe("useDiffComments", () => {
  it("restores a held batch and hands out ids past it", () => {
    saveDiffComments(undefined, "pane:w1:p1", [comment(4), comment(7)]);
    const { result } = renderHook(() => useDiffComments(undefined, "pane:w1:p1"));
    expect(result.current.comments.map((c) => c.id)).toEqual([4, 7]);
    expect(result.current.nextId()).toBe(8);
  });

  it("writes every change back and reads the other target's batch when the target changes", () => {
    saveDiffComments(undefined, "pane:w1:p2", [comment(9)]);
    const { result, rerender } = renderHook(({ target }) => useDiffComments(undefined, target), {
      initialProps: { target: "pane:w1:p1" },
    });
    act(() => result.current.setComments(() => [comment(1)]));
    expect(loadDiffComments(undefined, "pane:w1:p1").map((c) => c.id)).toEqual([1]);

    rerender({ target: "pane:w1:p2" });
    expect(result.current.comments.map((c) => c.id)).toEqual([9]);
    expect(loadDiffComments(undefined, "pane:w1:p1").map((c) => c.id)).toEqual([1]);

    act(() => result.current.setComments(() => []));
    expect(loadDiffComments(undefined, "pane:w1:p2")).toEqual([]);
  });
});

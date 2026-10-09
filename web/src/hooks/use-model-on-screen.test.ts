import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MISSES_TO_SHOW, stepModelOnScreen, useModelOnScreen, type ModelOnScreen } from "./use-model-on-screen";

const NAMES = ["[Opus 4.8] ctx:3%"];
const SILENT = ["ctx:3% ~/webapp"];

function frames(count: number): string[][] {
  return Array.from({ length: count }, () => [...SILENT]); // a fresh array per frame, as a poll gives
}

describe("useModelOnScreen", () => {
  it("is true at once from the first frame that names the model, so the label never flashes", () => {
    const { result } = renderHook(() => useModelOnScreen("p1|Opus 4.8", true, NAMES, "Opus 4.8"));
    expect(result.current).toBe(true);
  });

  it("is false where no row names the model", () => {
    const { result } = renderHook(() => useModelOnScreen("p1|Opus 4.8", true, SILENT, "Opus 4.8"));
    expect(result.current).toBe(false);
  });

  it("holds through a frame with no rows (a dialog took the statusline) and through a stray frame", () => {
    const { result, rerender } = renderHook(
      ({ rows }) => useModelOnScreen("p1|Opus 4.8", true, rows, "Opus 4.8"),
      { initialProps: { rows: NAMES } },
    );
    rerender({ rows: [] });
    expect(result.current).toBe(true);
    rerender({ rows: [...SILENT] });
    rerender({ rows: [...SILENT] });
    expect(result.current).toBe(true); // MISSES_TO_SHOW - 1 frames of a different footer
    rerender({ rows: [...NAMES] });
    rerender({ rows: [...SILENT] });
    rerender({ rows: [...SILENT] });
    expect(result.current).toBe(true); // the name in between started the count over
  });

  it("gives the label back after the footer stops naming the model for good", () => {
    const { result, rerender } = renderHook(
      ({ rows }) => useModelOnScreen("p1|Fable 5.1", true, rows, "Fable 5.1"),
      { initialProps: { rows: ["[Fable 5.1] ctx:3%"] } },
    );
    expect(result.current).toBe(true);
    for (const rows of frames(MISSES_TO_SHOW)) rerender({ rows });
    expect(result.current).toBe(false);
    rerender({ rows: ["[Fable 5.1] ctx:4%"] });
    expect(result.current).toBe(true); // and hides again the moment it names it
  });

  it("does not count a re-render of the same frame twice", () => {
    const { result, rerender } = renderHook(
      ({ rows }) => useModelOnScreen("p1|Opus 4.8", true, rows, "Opus 4.8"),
      { initialProps: { rows: NAMES } },
    );
    const frame = [...SILENT];
    for (let i = 0; i < 2 * MISSES_TO_SHOW; i++) rerender({ rows: frame });
    expect(result.current).toBe(true); // one frame, counted once
  });

  it("is false when the phone draws no footer (the question says shown = false)", () => {
    const { result } = renderHook(() => useModelOnScreen("p1|Opus 4.8", false, NAMES, "Opus 4.8"));
    expect(result.current).toBe(false);
  });

  it("starts over for another pane or model", () => {
    const { result, rerender } = renderHook(
      ({ key, rows }) => useModelOnScreen(key, true, rows, "Opus 4.8"),
      { initialProps: { key: "p1|Opus 4.8", rows: NAMES } },
    );
    expect(result.current).toBe(true);
    rerender({ key: "p2|Opus 4.8", rows: [...SILENT] });
    expect(result.current).toBe(false);
  });
});

describe("stepModelOnScreen", () => {
  const at: ModelOnScreen = { key: "k", rows: [], named: true, misses: 0 };

  it("a null frame changes nothing but the frame it has counted", () => {
    const rows = ["x"];
    expect(stepModelOnScreen(at, rows, null)).toEqual({ ...at, rows });
  });

  it("the same frame again is the same state", () => {
    expect(stepModelOnScreen(at, at.rows, false)).toBe(at);
  });
});

import { act, renderHook } from "@testing-library/react";

import { __resetDashFilter, DASH_FILTER_ENTRY, useDashFilter } from "./dash-filter";

describe("the Dashboard filter's store", () => {
  beforeEach(() => __resetDashFilter());

  it("enters by the magnifier, the playground round's default", () => {
    expect(DASH_FILTER_ENTRY).toBe("button");
  });

  it("starts empty and closed", () => {
    const { result } = renderHook(() => useDashFilter("h"));
    expect(result.current).toMatchObject({ query: "", open: false });
  });

  it("holds the query and the open state per scope, across a remount", () => {
    const first = renderHook(() => useDashFilter("h1"));
    act(() => {
      first.result.current.setQuery("moon");
      first.result.current.setOpen(true);
    });
    first.unmount();
    const again = renderHook(() => useDashFilter("h1"));
    expect(again.result.current).toMatchObject({ query: "moon", open: true });
    const other = renderHook(() => useDashFilter("h2"));
    expect(other.result.current).toMatchObject({ query: "", open: false });
  });

  it("tells every reader of a scope at once", () => {
    const a = renderHook(() => useDashFilter("h"));
    const b = renderHook(() => useDashFilter("h"));
    act(() => a.result.current.setQuery("x"));
    expect(b.result.current.query).toBe("x");
  });

  it("returns a stable state while nothing changes, and writes nothing to the device", () => {
    const { result, rerender } = renderHook(() => useDashFilter("h"));
    act(() => result.current.setQuery("secret-query"));
    const set = result.current.setQuery;
    rerender();
    expect(result.current.setQuery).toBe(set);
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain("secret-query");
  });

  it("is gone after a reset, as after a page load", () => {
    const { result } = renderHook(() => useDashFilter("h"));
    act(() => result.current.setQuery("moon"));
    act(() => __resetDashFilter());
    expect(result.current.query).toBe("");
  });
});

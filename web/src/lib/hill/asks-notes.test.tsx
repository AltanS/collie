import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { __resetAskNotes, clearAskNotes, noteAskSend, useAskNote } from "./asks-notes";

afterEach(() => act(() => __resetAskNotes()));

describe("what a Send said about one ask", () => {
  it("holds the words by ask id and lets go when the ask is sent again", () => {
    const one = renderHook(() => useAskNote("dc_a"));
    const other = renderHook(() => useAskNote("dc_b"));
    expect(one.result.current).toBeNull();
    act(() => noteAskSend("dc_a", "This ask closed before your answer arrived."));
    expect(one.result.current).toBe("This ask closed before your answer arrived.");
    expect(other.result.current).toBeNull();
    act(() => clearAskNotes(["dc_a", "dc_zzz"]));
    expect(one.result.current).toBeNull();
  });
});

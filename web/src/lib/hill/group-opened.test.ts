import { act, renderHook } from "@testing-library/react";
import { afterEach } from "vitest";

import { readOpenedCards, useOpenedCards } from "./group-opened";

// Which cards of a group this phone opened (crew slice 8): memory and sessionStorage, by id AND digest.

afterEach(() => sessionStorage.clear());

const DIGEST = "d".repeat(64);

describe("the opened cards of a group", () => {
  it("marks a card once, keeps it in sessionStorage, and reads it back for the same id and digest only", () => {
    const { result } = renderHook(() => useOpenedCards("dc_aaaaaaaaaaaa", DIGEST));
    expect([...result.current.opened]).toEqual([]);
    act(() => result.current.mark(1));
    act(() => result.current.mark(3));
    act(() => result.current.mark(1));
    expect([...result.current.opened].toSorted()).toEqual([1, 3]);
    expect([...readOpenedCards("dc_aaaaaaaaaaaa", DIGEST)].toSorted()).toEqual([1, 3]);
    // A new digest is a new group: none of the old marks count.
    expect([...readOpenedCards("dc_aaaaaaaaaaaa", "e".repeat(64))]).toEqual([]);
    expect([...readOpenedCards("dc_bbbbbbbbbbbb", DIGEST)]).toEqual([]);
  });

  it("reads a damaged value as no card opened, and drops a card number out of range", () => {
    sessionStorage.setItem(`collie:hill-group-opened:v1:dc_aaaaaaaaaaaa:${DIGEST}`, "not json");
    expect([...readOpenedCards("dc_aaaaaaaaaaaa", DIGEST)]).toEqual([]);
    sessionStorage.setItem(`collie:hill-group-opened:v1:dc_aaaaaaaaaaaa:${DIGEST}`, "[0, 2, 9, 2.5, \"3\"]");
    expect([...readOpenedCards("dc_aaaaaaaaaaaa", DIGEST)]).toEqual([2]);
  });
});

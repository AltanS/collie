import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  __reloadMaskedHint,
  __resetMaskedHint,
  maskedHintRetired,
  retireMaskedHint,
  useMaskedHintRetired,
} from "./masked-hint";

const KEY = "collie:masked-hint:v1";

beforeEach(() => __resetMaskedHint());

describe("masked-text hint flag", () => {
  it("starts unretired with nothing stored, and a read writes nothing", () => {
    expect(maskedHintRetired()).toBe(false);
    const { result } = renderHook(() => useMaskedHintRetired());
    expect(result.current).toBe(false);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("retires on the dismiss, under its own key, and survives a reload", () => {
    const { result } = renderHook(() => useMaskedHintRetired());
    act(() => retireMaskedHint());
    expect(result.current).toBe(true);
    expect(localStorage.getItem(KEY)).toBe("1");
    __reloadMaskedHint();
    expect(maskedHintRetired()).toBe(true);
    expect(Object.keys(localStorage)).toEqual([KEY]);
  });
});

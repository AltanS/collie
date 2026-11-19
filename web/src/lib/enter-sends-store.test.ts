import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __reloadEnterSendsStore, __resetEnterSendsStore, enterSendsChoice, setEnterSends } from "./enter-sends-store";

const KEY = "collie:enter-sends:v1";

beforeEach(() => __resetEnterSendsStore());
afterEach(() => __resetEnterSendsStore());

describe("the Enter-sends store", () => {
  it("holds no choice on a device that stored nothing", () => {
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(enterSendsChoice()).toBeNull();
  });

  it("writes a choice, either way, and keeps it across a reload", () => {
    setEnterSends(true);
    expect(localStorage.getItem(KEY)).toBe("on");
    __reloadEnterSendsStore();
    expect(enterSendsChoice()).toBe("on");
    setEnterSends(false);
    expect(localStorage.getItem(KEY)).toBe("off");
    __reloadEnterSendsStore();
    expect(enterSendsChoice()).toBe("off");
  });

  it.each(["true", "1", "0", "yes", "", "{oops"])("reads a bad stored value (%j) as no choice", (bad) => {
    localStorage.setItem(KEY, bad);
    __reloadEnterSendsStore();
    expect(enterSendsChoice()).toBeNull();
  });

  it("keeps the choice in memory when storage refuses a write", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("quota");
    };
    try {
      setEnterSends(true);
      expect(enterSendsChoice()).toBe("on");
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});

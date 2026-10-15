import { beforeEach, describe, expect, it } from "vitest";

import { DESIGN_STORAGE_KEY, __resetDesign, designPrefs, parseDesignPrefs, setDesignFont, setDesignTheme } from "./design";

// The device look is an object so it can grow siblings. These cases hold the newest sibling, the
// colour theme (M57), to the rule that a field this build knows is never dropped by a write to
// another one.

const stored = () => JSON.parse(localStorage.getItem(DESIGN_STORAGE_KEY) ?? "null");

beforeEach(() => {
  localStorage.clear();
  __resetDesign();
});

describe("the theme field", () => {
  it("reads an id of the right shape and keeps it even when no such theme exists", () => {
    expect(parseDesignPrefs('{"font":"aldrich","theme":"midnight"}')).toEqual({ font: "aldrich", theme: "midnight" });
    expect(parseDesignPrefs('{"font":"aldrich","theme":"gone-tomorrow"}').theme).toBe("gone-tomorrow");
  });

  it("drops a value that is not an id, and treats collie as absence", () => {
    for (const bad of ['"Has Caps"', '"a;b"', '""', "5", "null", '"-lead"', `"${"a".repeat(33)}"`, '"collie"']) {
      expect(parseDesignPrefs(`{"font":"system","theme":${bad}}`)).toEqual({ font: "system" });
    }
  });

  it("round-trips through storage", () => {
    setDesignTheme("midnight");
    expect(stored()).toEqual({ font: "aldrich", theme: "midnight" });
    __resetDesign();
    expect(designPrefs().theme).toBe("midnight");
  });

  it("omits the field for collie, so the blob is what a device that never chose stores", () => {
    setDesignTheme("midnight");
    setDesignTheme("collie");
    expect(stored()).toEqual({ font: "aldrich" });
  });

  it("ignores an id of the wrong shape", () => {
    setDesignTheme("midnight");
    setDesignTheme("Bad Id");
    expect(designPrefs().theme).toBe("midnight");
  });

  it("survives a change of face, and a change of theme keeps the face and the operator mirror", () => {
    setDesignTheme("midnight");
    setDesignFont("system");
    expect(stored()).toEqual({ font: "system", theme: "midnight" });
    setDesignFont("op:depart.woff2", { family: "Depart", basename: "depart.woff2" });
    setDesignTheme("other");
    expect(stored()).toEqual({
      font: "op:depart.woff2",
      operatorFont: { family: "Depart", basename: "depart.woff2" },
      theme: "other",
    });
  });
});

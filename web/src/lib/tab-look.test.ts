import { describe, expect, it } from "vitest";

import { shippedThemes } from "@/lib/theme/store";

import { tabLook } from "./tab-look";

describe("tabLook", () => {
  it("is plain when the theme names no word", () => {
    expect(tabLook(undefined)).toBe("plain");
  });

  it("reads each word of the token", () => {
    expect(tabLook("plain")).toBe("plain");
    expect(tabLook("folder")).toBe("folder");
  });

  it("is the folder tab for the default theme and Petal, and plain for every shipped theme that names no word", () => {
    const words = shippedThemes().map((theme) => [theme.id, tabLook(theme.surface?.tabs)]);
    expect(words).toEqual([
      ["collie", "folder"],
      ["nightwatch", "plain"],
      ["daylight", "plain"],
      ["harbour", "plain"],
      ["petal", "folder"],
    ]);
  });
});

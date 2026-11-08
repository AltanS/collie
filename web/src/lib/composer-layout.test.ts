import { describe, expect, it } from "vitest";

import { shippedThemes } from "@/lib/theme/store";

import { composerLayout } from "./composer-layout";

describe("composerLayout", () => {
  it("is the field when the theme names no word", () => {
    expect(composerLayout(undefined)).toBe("field");
  });

  it("reads each word of the token", () => {
    expect(composerLayout("field")).toBe("field");
    expect(composerLayout("box")).toBe("box");
  });

  it("is the box for the default theme and Petal, and the field for every shipped theme that names no word", () => {
    const words = shippedThemes().map((theme) => [theme.id, composerLayout(theme.surface?.composer)]);
    expect(words).toEqual([
      ["collie", "box"],
      ["nightwatch", "field"],
      ["daylight", "field"],
      ["harbour", "field"],
      ["petal", "box"],
    ]);
  });
});

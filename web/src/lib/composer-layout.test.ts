import { describe, expect, it } from "vitest";

import { composerLayout } from "./composer-layout";

describe("composerLayout", () => {
  it("is the field when the theme names no word", () => {
    expect(composerLayout(undefined)).toBe("field");
  });

  it("reads each word of the token", () => {
    expect(composerLayout("field")).toBe("field");
    expect(composerLayout("box")).toBe("box");
  });
});

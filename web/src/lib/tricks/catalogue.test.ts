import { describe, expect, it } from "vitest";

import { PLACES } from "./catalogue";

describe("the places of the catalogue", () => {
  it("the bottom bar item says where it stands on a large screen, where the bar is gone", () => {
    const where = PLACES.tabbar.where;
    expect(where).toContain("bottom bar");
    expect(where).toContain("after the Hill");
    expect(where).toContain("large screen");
    expect(where).toContain("header");
  });
});

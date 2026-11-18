import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { PLACE_ORDER } from "../web/src/lib/tricks/catalogue.ts";
import { PLACE_IDS } from "./docs-places.ts";

describe("the place pictures of the tricks docs", () => {
  test("there is one picture for every place Collie knows, and no other", () => {
    expect(PLACE_IDS.toSorted()).toEqual(PLACE_ORDER.toSorted());
  });

  test("every picture the reference names is in docs/images/tricks (run: bun scripts/docs-places.ts)", () => {
    const dir = join(import.meta.dir, "../docs/images/tricks");
    for (const name of ["places.png", ...PLACE_IDS.map((id) => `place-${id}.png`)]) expect(existsSync(join(dir, name))).toBe(true);
  });
});

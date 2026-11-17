import { describe, expect, test } from "bun:test";

import { API_CALL_MS, API_LEVELS } from "../../cli/trick-kit/trick.ts";
import { OPERATION_LEVELS } from "../api/operations.ts";

// The helper holds a hard-coded copy of the table's levels (it imports nothing of Collie, so a trick folder
// needs no install). This holds the copy to the bridge's own table: a new operation or a changed level is a
// red test here until the helper says it too (M105 spec 04, decision 4).

describe("the helper's operation levels", () => {
  test("they equal the local API's table, name for name", () => {
    expect(Object.fromEntries(Object.entries(API_LEVELS))).toEqual(Object.fromEntries(Object.entries(OPERATION_LEVELS)));
  });

  test("a call takes at most 3 seconds", () => {
    expect(API_CALL_MS).toBe(3000);
  });
});

// The cassette check over the committed tree, on every CI test run (the web vitest job runs the `rig`
// project). A finding names the file and line, never the matched text. See replay/check.ts.
import { describe, expect, it } from "vitest";

import { checkCassettes } from "./replay/check";
import { CASSETTE_ROOT } from "./replay/tier";

describe("the committed cassettes", () => {
  it("hold no failed mark, no key, no home path, no host name and no file over 512 KiB", () => {
    expect(checkCassettes(CASSETTE_ROOT)).toEqual([]);
  });
});

// The probe's token rule: a paired device's token from COLLIE_TOKEN, and nothing else. The bridge's own
// local key reads no pane (bridge/local-key.ts), so it is never a fallback. The probe itself needs a
// live crew and is not run here.
import { describe, expect, test } from "bun:test";

import { authHeaders, NO_TOKEN_LINE } from "./crew-mux-probe.ts";

describe("crew-mux-probe authHeaders", () => {
  test("COLLIE_TOKEN is the header, trimmed", () => {
    expect(authHeaders({ COLLIE_TOKEN: " tok-placeholder " })).toEqual({ authorization: "Bearer tok-placeholder" });
  });

  test("no COLLIE_TOKEN, or a blank one: no header, even with a state folder that holds the local key", () => {
    expect(authHeaders({ COLLIE_STATE_DIR: "/tmp/collie-test-state" })).toBeNull();
    expect(authHeaders({ COLLIE_TOKEN: "  ", COLLIE_STATE_DIR: "/tmp/collie-test-state" })).toBeNull();
  });

  test("the stop line names the next step in one line", () => {
    expect(NO_TOKEN_LINE).toContain("COLLIE_TOKEN");
    expect(NO_TOKEN_LINE).toContain("collie pair");
    expect(NO_TOKEN_LINE).not.toContain("\n");
  });
});

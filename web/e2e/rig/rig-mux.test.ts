// COLLIE_RIG_MUX, read the one way the rig, the leg and the Makefile mean it (rig-mux.ts).
import { describe, expect, it } from "vitest";

import { coreSocketIn, rigMuxFrom } from "./rig-mux";

describe("COLLIE_RIG_MUX", () => {
  it("is Herdr on both machines when unset or empty, as the leg always ran", () => {
    expect(rigMuxFrom(undefined)).toEqual({ lead: "herdr", member: "herdr" });
    expect(rigMuxFrom("")).toEqual({ lead: "herdr", member: "herdr" });
  });

  it("puts one name on both machines, and two names on the lead and the member", () => {
    expect(rigMuxFrom("herdr-core")).toEqual({ lead: "herdr-core", member: "herdr-core" });
    expect(rigMuxFrom("herdr,herdr-core")).toEqual({ lead: "herdr", member: "herdr-core" });
    expect(rigMuxFrom(" herdr-core , herdr ")).toEqual({ lead: "herdr-core", member: "herdr" });
  });

  it("refuses any other word, and a third machine", () => {
    for (const raw of ["tmux", "herdr,", "herdr,herdr,herdr", "HERDR"]) expect(() => rigMuxFrom(raw)).toThrow(/COLLIE_RIG_MUX/);
  });

  it("puts the core's socket in the rig's short home", () => {
    expect(coreSocketIn("/run/user/7/collie-rig-0123abcd")).toBe("/run/user/7/collie-rig-0123abcd/hc.sock");
  });
});

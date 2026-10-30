// COLLIE_RIG_MUX, read the one way the rig, the leg and the Makefile mean it (rig-mux.ts).
import { describe, expect, it } from "vitest";

import { CORE_RIG_LABEL, coreRunArgs, coreSocketIn, rigMuxFrom } from "./rig-mux";

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

  it("starts a core terminal with no name, the rig's label as an hc label (a name is the pane's label, and a walky header's)", () => {
    const args = coreRunArgs("/lab/pi/project", "leg-pi", ["sh", "-c", "exec '/lab/pi/start.sh'"]);
    expect(args).not.toContain("--name");
    expect(args).toEqual(["run", "--bg", "--label", `${CORE_RIG_LABEL}=leg-pi`, "--cwd", "/lab/pi/project", "--no-parent", "--no-notify", "--", "sh", "-c", "exec '/lab/pi/start.sh'"]);
    expect(coreRunArgs("/lab/work", "rig-abc", [])).toEqual(["run", "--bg", "--label", `${CORE_RIG_LABEL}=rig-abc`, "--cwd", "/lab/work", "--no-parent", "--no-notify"]);
  });
});

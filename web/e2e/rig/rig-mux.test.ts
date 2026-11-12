// COLLIE_RIG_MUX, read the one way the rig, the leg and the Makefile mean it (rig-mux.ts).
import { describe, expect, it } from "vitest";

import { asJsonObject } from "../../src/lib/json";

import { CORE_LAYOUT_DOC, CORE_RIG_LABEL, CORE_SPACE_LABEL, CORE_TAB_LABEL, coreRunArgs, coreSocketIn, coreSpaceIds, coreSpaceLabels, coreUnnamedSpaceIds, layoutWithSpace, rigMuxFrom } from "./rig-mux";

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

  it("adds a space's labels to a core terminal after the rig's own label, and none by default", () => {
    const labels = coreSpaceLabels(coreSpaceIds("collie-rig-space"));
    expect(labels).toEqual({ [CORE_SPACE_LABEL]: "sp-rig-collie-rig-space", [CORE_TAB_LABEL]: "tb-rig-collie-rig-space" });
    expect(coreRunArgs("/lab/work", "leg-pi", ["sh"], labels)).toEqual([
      "run",
      "--bg",
      "--label",
      `${CORE_RIG_LABEL}=leg-pi`,
      "--label",
      "herdr.space=sp-rig-collie-rig-space",
      "--label",
      "herdr.tab=tb-rig-collie-rig-space",
      "--cwd",
      "/lab/work",
      "--no-parent",
      "--no-notify",
      "--",
      "sh",
    ]);
  });

  it("gives one name the same ids on every machine, and an unnamed space ids no document names", () => {
    expect(coreSpaceIds("collie-rig-space")).toEqual(coreSpaceIds("collie-rig-space"));
    expect(coreSpaceIds("collie-rig-space")).not.toEqual(coreSpaceIds("collie-rig-other-space"));
    const unnamed = coreUnnamedSpaceIds("abc");
    expect(unnamed).not.toEqual(coreSpaceIds("abc"));
    expect(layoutWithSpace(null, "abc").value).toEqual({ spaces: [{ id: "sp-rig-abc", name: "abc", folder: "", tabs: [{ id: "tb-rig-abc", name: "" }] }] });
  });

  it("writes a named space into herdr-app's document once, and keeps every other field", () => {
    expect(CORE_LAYOUT_DOC).toBe("herdr-app");
    const first = layoutWithSpace(null, "collie-rig-space");
    expect(first.changed).toBe(true);
    expect(first.value).toEqual({ spaces: [{ id: "sp-rig-collie-rig-space", name: "collie-rig-space", folder: "", tabs: [{ id: "tb-rig-collie-rig-space", name: "" }] }] });
    // The same name again changes nothing, so a second pane of the space writes no document.
    const again = layoutWithSpace(first.value, "collie-rig-space");
    expect(again.changed).toBe(false);
    expect(again.value).toBe(first.value);
    // Another space is added beside it, and a field the rig does not know stays.
    const both = layoutWithSpace({ ...first.value, other: 1 }, "collie-rig-other-space");
    expect(both.changed).toBe(true);
    expect(both.value).toMatchObject({ other: 1 });
    expect((Array.isArray(both.value.spaces) ? both.value.spaces : []).map((space) => asJsonObject(space)?.name)).toEqual(["collie-rig-space", "collie-rig-other-space"]);
  });
});

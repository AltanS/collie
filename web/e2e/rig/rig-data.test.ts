import { describe, expect, test } from "vitest";

import { planTiers } from "./replay/tier";
import { cassetteLeg, dataBridgeEnv, dataClaude, rigDataFrom } from "./rig-data";

describe("the data path in the leg (M99 spec 13)", () => {
  test("off unless COLLIE_RIG_DATA=1; any other word stops the run", () => {
    expect(rigDataFrom(undefined)).toBe(false);
    expect(rigDataFrom("")).toBe(false);
    expect(rigDataFrom("0")).toBe(false);
    expect(rigDataFrom("1")).toBe(true);
    expect(() => rigDataFrom("yes")).toThrow("COLLIE_RIG_DATA");
  });

  test("the default run is unchanged: its own cassette leg, the socket closed, no mod", () => {
    expect(cassetteLeg("solo", false)).toBe("solo");
    expect(cassetteLeg("crew", false)).toBe("crew");
    expect(dataBridgeEnv(false)).toEqual({ COLLIE_INSIDE: "0" });
    expect(dataClaude("/w", "/b", false)).toEqual({ argv: [], env: {} });
  });

  test("a data run: its own cassettes, the socket open, the mod from the checkout, its own bridge's targets", () => {
    expect(cassetteLeg("solo", true)).toBe("solo-data");
    expect(dataBridgeEnv(true)).toEqual({ COLLIE_INSIDE: "1" });
    expect(dataClaude("/w", "/b", true)).toEqual({ argv: ["--plugin-dir", "/w/inside/claude"], env: { XDG_STATE_HOME: "/b/.local/state" } });
  });

  test("a data run plans its tiers against the data cassettes", () => {
    const versions = { pi: null, omp: null, claude: "2.1.323" };
    expect(planTiers("solo", {}, versions).claude?.leg).toBe("solo");
    expect(planTiers("solo", { COLLIE_RIG_DATA: "1" }, versions).claude?.leg).toBe("solo-data");
  });
});

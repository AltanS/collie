import { describe, expect, test } from "bun:test";

import { loadConfig } from "../config.ts";
import { insideGate } from "./gate.ts";

describe("the inside socket opens only when the operator turns it on", () => {
  test("off by default: no setting, no socket", () => {
    const cfg = loadConfig({});
    expect(cfg.inside).toBe(false);
    expect(insideGate({ setting: cfg.inside, edges: true, platform: "linux" })).toBe("off");
  });

  test("on with COLLIE_INSIDE=1, where the edges run", () => {
    const cfg = loadConfig({ COLLIE_INSIDE: "1" });
    expect(cfg.inside).toBe(true);
    expect(insideGate({ setting: cfg.inside, edges: true, platform: "linux" })).toBe("open");
    expect(insideGate({ setting: cfg.inside, edges: true, platform: "darwin" })).toBe("open");
  });

  test("COLLIE_INSIDE=0 is the kill switch", () => {
    expect(insideGate({ setting: loadConfig({ COLLIE_INSIDE: "0" }).inside, edges: true, platform: "linux" })).toBe("off");
  });

  test("on, but no edges or Windows: still closed", () => {
    expect(insideGate({ setting: true, edges: false, platform: "linux" })).toBe("no-edges");
    expect(insideGate({ setting: true, edges: true, platform: "win32" })).toBe("platform");
  });
});
